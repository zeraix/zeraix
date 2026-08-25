//! Console output decoding, mirroring `decodeConsole` / `tailOf` in `sandbox/native.mjs`.
//!
//! A Windows console in a Chinese locale emits cp936/GB18030, not UTF-8. Decoding it as UTF-8 produces
//! a wall of `�`, which then goes into the model's context as the command's output — so the model is
//! reasoning about mojibake and cannot see the error the build actually printed.
//!
//! The heuristic is the JS one, kept identical because its output reaches the model: decode as UTF-8;
//! if that produced no replacement character, take it; otherwise decode as GB18030 too and keep
//! whichever has fewer. GB18030 wins ties, which matters because it is the encoding that was in doubt —
//! a pure-ASCII buffer never reaches the comparison at all.

/// Decode raw process output, choosing between UTF-8 and GB18030 by replacement-character count.
pub fn decode_console(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    // Lossy, never fatal: partial output cut mid-character at a buffer cap must still decode.
    let utf8 = String::from_utf8_lossy(bytes);
    if !utf8.contains('\u{FFFD}') {
        return utf8.into_owned();
    }
    let (gbk, _, _) = encoding_rs::GB18030.decode(bytes);
    let bad = |s: &str| s.matches('\u{FFFD}').count();
    if bad(&gbk) <= bad(&utf8) { gbk.into_owned() } else { utf8.into_owned() }
}

/// The last `max` characters of decoded output, prefixed with an elision marker when truncated.
///
/// Counts characters the way JS `String.prototype.slice` does — UTF-16 code units — because the
/// notice this feeds is compared against the JS implementation's.
pub fn tail_of(bytes: &[u8], max: usize) -> String {
    let s = decode_console(bytes).trim().to_owned();
    let units: usize = s.chars().map(char::len_utf16).sum();
    if units <= max {
        return s;
    }
    // Walk back from the end until `max` code units are covered, then cut on that char boundary.
    let mut taken = 0usize;
    let mut start = s.len();
    for (idx, ch) in s.char_indices().rev() {
        let next = taken + ch.len_utf16();
        if next > max {
            break;
        }
        taken = next;
        start = idx;
    }
    format!("…\n{}", &s[start..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_utf8_passes_through() {
        assert_eq!(decode_console(b"hello\n"), "hello\n");
        assert_eq!(decode_console("中文".as_bytes()), "中文");
    }

    #[test]
    fn empty_input_is_empty_output() {
        assert_eq!(decode_console(b""), "");
    }

    #[test]
    fn gb18030_output_is_recovered() {
        // "中文" in GB18030 is not valid UTF-8, so the UTF-8 attempt produces replacements and the
        // GB18030 decode wins. This is the case the whole heuristic exists for.
        let (bytes, _, _) = encoding_rs::GB18030.encode("中文");
        assert_eq!(decode_console(&bytes), "中文");
    }

    #[test]
    fn genuinely_binary_output_still_returns_something() {
        // Neither encoding is right; the point is that it does not panic and does not lose length.
        let out = decode_console(&[0xff, 0xfe, 0x00, 0x01]);
        assert!(!out.is_empty());
    }

    #[test]
    fn tail_truncates_from_the_end_with_a_marker() {
        let long = "x".repeat(50);
        let t = tail_of(long.as_bytes(), 10);
        assert!(t.starts_with("…\n"));
        assert_eq!(t.chars().filter(|c| *c == 'x').count(), 10);
    }

    #[test]
    fn tail_leaves_short_output_alone() {
        assert_eq!(tail_of(b"  short  ", 100), "short");
    }

    #[test]
    fn tail_does_not_split_a_character() {
        let s = "中".repeat(20);
        let t = tail_of(s.as_bytes(), 5);
        // Cut on a char boundary; never a partial code point. (Strip by prefix, not by byte offset —
        // '…' is three bytes.)
        let body = t.strip_prefix("…\n").expect("expected the elision marker");
        assert!(body.chars().all(|c| c == '中'));
        assert_eq!(body.chars().count(), 5);
    }
}
