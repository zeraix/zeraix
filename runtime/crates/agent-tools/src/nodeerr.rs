//! Node-compatible filesystem error messages.
//!
//! A failed tool call returns its error text to the model, and the JS handlers let Node's own error
//! message through: `ENOENT: no such file or directory, stat '/abs/path'`. Rust's `io::Error` formats
//! the same condition as `No such file or directory (os error 2)`.
//!
//! Both are perfectly clear to a human, which is exactly why this is easy to shrug off — and it would
//! still be a behaviour change. The string reaches the model, the usage log and the UI bubble; a model
//! that has learned to recognise `ENOENT` would start seeing something else only when the flag is on,
//! which is the kind of difference that shows up as "the new runtime behaves oddly" long after anyone
//! remembers this decision. The A/B harness treats it as a divergence, and it is right to.
//!
//! Mapping is by `ErrorKind` rather than raw errno so it holds on Windows, where the numbers differ but
//! Node still reports the libuv name.

use agent_core::{Result, RuntimeError};
use std::io::{Error, ErrorKind};
use std::path::Path;

/// The libuv code and message Node would report for this error.
fn describe(e: &Error) -> (&'static str, &'static str) {
    match e.kind() {
        ErrorKind::NotFound => ("ENOENT", "no such file or directory"),
        ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        ErrorKind::AlreadyExists => ("EEXIST", "file already exists"),
        ErrorKind::NotADirectory => ("ENOTDIR", "not a directory"),
        ErrorKind::IsADirectory => ("EISDIR", "illegal operation on a directory"),
        ErrorKind::DirectoryNotEmpty => ("ENOTEMPTY", "directory not empty"),
        ErrorKind::InvalidInput => ("EINVAL", "invalid argument"),
        _ => match e.raw_os_error() {
            // Errnos with no portable `ErrorKind`, spelled the way libuv does.
            Some(40) => ("ELOOP", "too many symbolic links encountered"),
            Some(36) => ("ENAMETOOLONG", "name too long"),
            Some(24) => ("EMFILE", "too many open files"),
            Some(28) => ("ENOSPC", "no space left on device"),
            Some(5) => ("EIO", "i/o error"),
            _ => ("UNKNOWN", "unknown error"),
        },
    }
}

/// Format an io error the way Node would, and classify it for the runtime error model.
///
/// `syscall` is the name Node reports, which is the *libuv* operation rather than the Rust call:
/// `stat` for metadata, `scandir` for a directory listing, `open`/`read` for file contents.
pub fn fs_error(e: &Error, syscall: &str, path: &Path) -> RuntimeError {
    let (code, msg) = describe(e);
    let text = format!("{code}: {msg}, {syscall} '{}'", path.display());
    // Not-found and permission problems are the caller's to fix, not conditions to retry.
    RuntimeError::invalid("tool.fs_error", text)
}

/// Convenience for the common `metadata` call.
pub fn stat_error(e: &Error, path: &Path) -> RuntimeError {
    fs_error(e, "stat", path)
}

/// `String(value)` as JavaScript performs it, for the arguments the JS handlers coerce rather than
/// validate.
///
/// `search_files` does `globToRegExp(String(pattern))`, so a missing `pattern` searches for a file
/// literally named `undefined` instead of failing. That is not a behaviour worth defending, but it is
/// the behaviour, and Stage 1 is not the place to change it — tightening validation deserves its own
/// commit where it can be seen.
pub fn coerce_string(v: Option<&serde_json::Value>) -> String {
    use serde_json::Value;
    match v {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| match x {
                Value::Null => String::new(),
                other => coerce_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
    }
}

/// A path argument, checked the way `resolveInside` checks it.
///
/// The JS helper throws `"path must be a string"` for anything that is not a string — including a
/// missing argument — so both cases produce one message here rather than distinguishing them.
pub fn path_arg(args: &serde_json::Value, key: &str) -> Result<String> {
    match args.get(key) {
        Some(serde_json::Value::String(s)) => Ok(s.clone()),
        _ => Err(RuntimeError::invalid(
            "tool.invalid_argument",
            format!("{key} must be a string"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn formats_enoent_like_node() {
        let e = Error::from(ErrorKind::NotFound);
        let r = fs_error(&e, "stat", Path::new("/tmp/x"));
        assert_eq!(r.message, "ENOENT: no such file or directory, stat '/tmp/x'");
    }

    #[test]
    fn coerces_like_javascript() {
        assert_eq!(coerce_string(None), "undefined");
        assert_eq!(coerce_string(Some(&json!(null))), "null");
        assert_eq!(coerce_string(Some(&json!("x"))), "x");
        assert_eq!(coerce_string(Some(&json!(3))), "3");
        assert_eq!(coerce_string(Some(&json!(true))), "true");
        assert_eq!(coerce_string(Some(&json!({}))), "[object Object]");
    }

    #[test]
    fn path_arg_rejects_non_strings_with_the_js_message() {
        assert_eq!(path_arg(&json!({}), "path").unwrap_err().message, "path must be a string");
        assert_eq!(path_arg(&json!({"path": 3}), "path").unwrap_err().message, "path must be a string");
        assert_eq!(path_arg(&json!({"path": "a"}), "path").unwrap(), "a");
    }
}
