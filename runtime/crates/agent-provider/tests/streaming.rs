//! A streamed reply as the network actually delivers it: in pieces, with gaps between them.
//!
//! `fallbacks.rs` answers each request with one `Content-Length` body, written at once. That is the shape in
//! which neither of these bugs can happen. Here the body is chunked and written a piece at a time, so a test
//! decides where the reads end and how long the connection goes quiet between them.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use agent_loop::{Message, ModelClient, ModelRequest};
use agent_provider::{HttpModel, ProviderConfig};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// A provider that answers every request with the same body, written as the given pieces with `gap` between
/// them. Counts the connections it accepted, because a retry is a new connection.
async fn chunked_provider(pieces: Vec<Vec<u8>>, gap: Duration) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    let connections = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&connections);
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else { break };
            counter.fetch_add(1, Ordering::SeqCst);
            let pieces = pieces.clone();
            tokio::spawn(async move {
                // The request body is small and not asserted on: one read is enough to get past it.
                let mut request = vec![0u8; 65536];
                let _ = socket.read(&mut request).await;
                let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n";
                if socket.write_all(head.as_bytes()).await.is_err() {
                    return;
                }
                for piece in pieces {
                    let mut frame = format!("{:x}\r\n", piece.len()).into_bytes();
                    frame.extend_from_slice(&piece);
                    frame.extend_from_slice(b"\r\n");
                    if socket.write_all(&frame).await.is_err() || socket.flush().await.is_err() {
                        return;
                    }
                    tokio::time::sleep(gap).await;
                }
                let _ = socket.write_all(b"0\r\n\r\n").await;
            });
        }
    });
    (format!("http://{addr}/v1/chat/completions"), connections)
}

fn event(content: &str) -> String {
    format!("data: {}\n\n", serde_json::json!({ "choices": [{ "delta": { "content": content } }] }))
}

fn streaming_model(url: String, idle: Duration) -> HttpModel {
    HttpModel::new(ProviderConfig {
        endpoint: url,
        model: "test-model".into(),
        stream: true,
        proxy: Some("direct".into()),
        idle_timeout: idle,
        ..Default::default()
    })
    .expect("client")
}

fn request() -> ModelRequest {
    ModelRequest { model: "test-model".into(), messages: vec![Message::user("hi")], ..Default::default() }
}

#[tokio::test]
async fn a_character_split_between_two_reads_arrives_intact() {
    let body = format!("{}data: [DONE]\n\n", event("你好世界"));
    // Cut inside the three bytes of the first character.
    let at = body.find('你').expect("the character") + 1;
    let pieces = vec![body.as_bytes()[..at].to_vec(), body.as_bytes()[at..].to_vec()];
    let (url, _) = chunked_provider(pieces, Duration::from_millis(100)).await;

    let turn = streaming_model(url, Duration::from_secs(10)).complete(&request()).await.expect("a reply");
    assert_eq!(turn.content, "你好世界");
}

/// A model still producing tokens is not a stalled connection, however long it has been going. Under a total
/// deadline this stream was cut at the limit, resent from scratch, and failed three times over.
#[tokio::test]
async fn a_stream_that_keeps_talking_outlives_the_idle_timeout() {
    let mut pieces: Vec<Vec<u8>> = (0..12).map(|i| event(&format!("t{i} ")).into_bytes()).collect();
    pieces.push(b"data: [DONE]\n\n".to_vec());
    // 12 pieces 100 ms apart: about 1.2 s in all, against an idle limit of 400 ms.
    let (url, connections) = chunked_provider(pieces, Duration::from_millis(100)).await;

    let turn = streaming_model(url, Duration::from_millis(400)).complete(&request()).await.expect("a reply");
    assert!(turn.content.starts_with("t0 t1 ") && turn.content.ends_with("t11 "), "{:?}", turn.content);
    assert_eq!(connections.load(Ordering::SeqCst), 1, "the stream must not have been cut and retried");
}

/// And a connection that really has gone quiet is still abandoned, rather than waited on for ever.
#[tokio::test]
async fn a_stream_that_goes_silent_is_abandoned() {
    // One token, then two seconds of nothing, against an idle limit of 200 ms.
    let pieces = vec![event("t0 ").into_bytes(), b"data: [DONE]\n\n".to_vec()];
    let (url, _) = chunked_provider(pieces, Duration::from_secs(2)).await;

    let err = streaming_model(url, Duration::from_millis(200)).complete(&request()).await.expect_err("a stall");
    assert!(err.message.contains("timed out"), "{}", err.message);
}
