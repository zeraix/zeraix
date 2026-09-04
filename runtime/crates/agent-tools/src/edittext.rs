//! The byte-level guarantees a write must keep, and the diff it reports.
//!
//! Ported from the encoding helpers in `aiToolkit.mjs`. Their purpose is stated there and is worth repeating,
//! because it is the whole reason this module is not three lines of `fs::write`:
//!
//! > These helpers let `write_file` / `edit_file` keep a file's original bytes intact outside the actual
//! > change — the "preserve encoding / line endings / BOM" guarantees, enforced in code rather than asked for
//! > in the prompt (a model cannot reliably deliver them itself).
//!
//! A model handed a CRLF file will return LF, every time, and a rewrite that accepted that would show every
//! line of the file as changed in the user's next `git diff`. So the newline style, the BOM and the encoding
//! are properties of the *file*, read before the write and restored after it — never properties of what the
//! model happened to send.
//!
//! ## Non-UTF-8 files are refused, not converted
//!
//! A GBK or UTF-16 file decoded as UTF-8 becomes `�` where its non-ASCII characters were, and writing that
//! back destroys the file. Refusing is the only safe answer, and the message says which encoding was found so
//! the user can convert deliberately.

use agent_core::{Result, RuntimeError};

/// A file's byte-level traits, captured before an edit so they can be restored after it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileText {
    /// Content with the BOM stripped and newlines normalised to LF, which is the space edits happen in.
    pub text: String,
    pub has_bom: bool,
    pub newline: Newline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Newline {
    Lf,
    Crlf,
}

impl Newline {
    /// The dominant newline: CRLF only when the file has CRLFs and they are at least as common as bare LFs.
    ///
    /// "At least as common" rather than "more common" so that a file of entirely CRLF lines — where the bare-LF
    /// count is zero — is not decided by a tie-break in the wrong direction.
    pub fn detect(text: &str) -> Self {
        let crlf = text.matches("\r\n").count();
        let lf = text.matches('\n').count() - crlf;
        if crlf > 0 && crlf >= lf { Newline::Crlf } else { Newline::Lf }
    }

    /// Re-emit LF-space content in this style, so an edit never leaves a file with mixed endings.
    pub fn apply(self, content: &str) -> String {
        match self {
            Newline::Lf => content.to_owned(),
            Newline::Crlf => content.replace('\n', "\r\n"),
        }
    }
}

/// Normalise to LF-space, where matching and splicing happen.
///
/// Doing the work in LF-space is what lets an `edit_file` match succeed whether the model supplied `\n` or
/// `\r\n` — it has no way to know which the file uses, and failing the match over it would be a fault the
/// model cannot correct.
pub fn to_lf(s: &str) -> String {
    s.replace("\r\n", "\n")
}

/// Read a file for editing, capturing what a write must preserve.
///
/// `None` means the file does not exist, which is not an error for `write_file` — it is a new file.
pub async fn read_for_edit(abs: &std::path::Path) -> Result<Option<FileText>> {
    let bytes = match tokio::fs::read(abs).await {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(crate::nodeerr::fs_error(&e, "open", abs)),
    };
    decode_for_edit(&bytes, abs).map(Some)
}

/// The pure half of [`read_for_edit`], so the encoding refusals can be tested without a filesystem.
pub fn decode_for_edit(bytes: &[u8], abs: &std::path::Path) -> Result<FileText> {
    let shown = abs.display();
    // A UTF-16/32 BOM: decoding as UTF-8 would corrupt it.
    if bytes.len() >= 2 && ((bytes[0] == 0xff && bytes[1] == 0xfe) || (bytes[0] == 0xfe && bytes[1] == 0xff)) {
        return Err(RuntimeError::invalid(
            "tool.not_utf8",
            format!(
                "{shown} is UTF-16 encoded, not UTF-8. This tool edits UTF-8 text only; editing it here would \
                 corrupt it. Convert it to UTF-8 first if you mean to work with it as text."
            ),
        ));
    }
    let has_bom = bytes.len() >= 3 && bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf;
    let body = if has_bom { &bytes[3..] } else { bytes };
    let decoded = std::str::from_utf8(body).map_err(|_| {
        RuntimeError::invalid(
            "tool.not_utf8",
            format!(
                "{shown} is not valid UTF-8 (it may be GBK, GB2312, or another legacy encoding). Editing it as \
                 text here would replace its non-ASCII characters with \"\u{fffd}\". Convert it to UTF-8 first."
            ),
        )
    })?;
    Ok(FileText {
        newline: Newline::detect(decoded),
        text: to_lf(decoded),
        has_bom,
    })
}

/// Encode LF-space content back to bytes in the file's own style, re-attaching a BOM if it had one.
pub fn encode(text: &str, newline: Newline, has_bom: bool) -> Vec<u8> {
    let styled = newline.apply(text);
    let mut out = Vec::with_capacity(styled.len() + 3);
    if has_bom {
        out.extend_from_slice(&[0xef, 0xbb, 0xbf]);
    }
    out.extend_from_slice(styled.as_bytes());
    out
}

/// Whether a text IS the renderer's context-trimming placeholder rather than file content.
///
/// The renderer replaces the bulky arguments of a completed write or edit in the model's context with a
/// marker of the form `[…… N lines elided: … ……]` (contextCompress.ts, releaseCallArguments). A model that
/// sees its own earlier writes rendered that way can imitate the shape when it writes the next file — seen
/// 2026-09-04: a `write_file` whose entire content was "[…… 19 lines elided: this text was written to
/// test_summary_detailed.csv; read_file it if you need it ……]", which then sat on disk as the file, and the
/// model spent its next ten calls on shell workarounds because "write_file truncates". The write and edit
/// tools refuse such content with a message that says what the marker is, and the model sends the real
/// text. Matched on the marker's shape — the whole text is one `[…… … ……]` — so every marker the app writes into
/// a conversation (elided arguments, a result kept on disk, a result no longer on disk) is covered, and the wording
/// between the brackets is free to change.
pub fn is_context_placeholder(text: &str) -> bool {
    let t = text.trim();
    t.starts_with("[…… ") && t.ends_with(" ……]")
}

/// The refusal the write and edit tools return for placeholder content. Model-facing.
pub const PLACEHOLDER_REFUSED: &str = "the text you sent is the context-trimming marker \"[…… N lines elided … ……]\", \
not file content. That marker stands in for text of your own earlier calls that was trimmed from your context; it is \
never valid content. Send the complete text you want in the file (read_file the current file first if you need what is there).";

/// A unified diff of two LF-space texts, as the tool result carries it.
///
/// The frontend renders this and the model reads it, so it is part of the tool's contract rather than a
/// convenience. Context is three lines either side, the conventional amount.
///
/// Implemented here rather than pulled in: a diff crate would be a new dependency for one function whose
/// output shape is fixed by what the renderer already parses.
pub fn unified_diff(before: &str, after: &str) -> String {
    if before == after {
        return String::new();
    }
    let a: Vec<&str> = before.split('\n').collect();
    let b: Vec<&str> = after.split('\n').collect();
    let ops = diff_ops(&a, &b);

    const CONTEXT: usize = 3;
    // Group changes into hunks, merging any that are within 2*CONTEXT of each other — otherwise adjacent
    // edits produce overlapping hunks that render as duplicated lines.
    let changed: Vec<usize> = ops
        .iter()
        .enumerate()
        .filter(|(_, op)| !matches!(op, Op::Keep(_)))
        .map(|(i, _)| i)
        .collect();
    if changed.is_empty() {
        return String::new();
    }

    let mut hunks: Vec<(usize, usize)> = Vec::new();
    let mut start = changed[0];
    let mut end = changed[0];
    for &i in &changed[1..] {
        if i - end <= CONTEXT * 2 {
            end = i;
        } else {
            hunks.push((start, end));
            start = i;
            end = i;
        }
    }
    hunks.push((start, end));

    let mut out = String::from("\n\n```diff");
    for (start, end) in hunks {
        let from = start.saturating_sub(CONTEXT);
        let to = (end + CONTEXT).min(ops.len() - 1);
        let (mut a_start, mut b_start) = (0usize, 0usize);
        for op in ops.iter().take(from) {
            match op {
                Op::Keep(_) => {
                    a_start += 1;
                    b_start += 1;
                }
                Op::Del(_) => a_start += 1,
                Op::Add(_) => b_start += 1,
            }
        }
        let (mut a_len, mut b_len) = (0usize, 0usize);
        for op in ops.iter().take(to + 1).skip(from) {
            match op {
                Op::Keep(_) => {
                    a_len += 1;
                    b_len += 1;
                }
                Op::Del(_) => a_len += 1,
                Op::Add(_) => b_len += 1,
            }
        }
        out.push_str(&format!("\n@@ -{},{} +{},{} @@", a_start + 1, a_len, b_start + 1, b_len));
        for op in ops.iter().take(to + 1).skip(from) {
            match op {
                Op::Keep(line) => out.push_str(&format!("\n {line}")),
                Op::Del(line) => out.push_str(&format!("\n-{line}")),
                Op::Add(line) => out.push_str(&format!("\n+{line}")),
            }
        }
    }
    out.push_str("\n```");
    out
}

enum Op<'a> {
    Keep(&'a str),
    Del(&'a str),
    Add(&'a str),
}

/// Longest-common-subsequence diff.
///
/// Quadratic in the number of lines, which is fine for the sizes this sees: a diff is only produced for a
/// file the model just wrote, and a model writes files a few thousand lines long at most. (`read_file` no
/// longer caps what it reads, but reading is not what gets diffed.)
fn diff_ops<'a>(a: &[&'a str], b: &[&'a str]) -> Vec<Op<'a>> {
    let (n, m) = (a.len(), b.len());
    // lcs[i][j] = length of the LCS of a[i..] and b[j..]
    let mut lcs = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if a[i] == b[j] { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    let mut ops = Vec::with_capacity(n.max(m));
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if a[i] == b[j] {
            ops.push(Op::Keep(a[i]));
            i += 1;
            j += 1;
        } else if lcs[i + 1][j] >= lcs[i][j + 1] {
            ops.push(Op::Del(a[i]));
            i += 1;
        } else {
            ops.push(Op::Add(b[j]));
            j += 1;
        }
    }
    while i < n {
        ops.push(Op::Del(a[i]));
        i += 1;
    }
    while j < m {
        ops.push(Op::Add(b[j]));
        j += 1;
    }
    ops
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn the_context_placeholder_is_recognised_and_ordinary_text_is_not() {
        assert!(is_context_placeholder(
            "[…… 19 lines elided: this text was written to test_summary_detailed.csv; read_file it if you need it ……]"
        ));
        assert!(is_context_placeholder("  […… 3 lines elided: the text this call replaced ……]\n"));
        assert!(is_context_placeholder(
            "[…… a 209,715,232-character tool result from an earlier session is kept on disk (0123) and not loaded into the conversation; call the tool again if you need it ……]"
        ));
        assert!(!is_context_placeholder("const x = 1; // […… nothing elided here"));
        assert!(!is_context_placeholder("[…… a marker, then real content ……]\nconst x = 1;"));
        assert!(!is_context_placeholder(""));
    }

    #[test]
    fn a_crlf_file_is_detected_and_a_lone_lf_file_is_not() {
        assert_eq!(Newline::detect("a\r\nb\r\nc"), Newline::Crlf);
        assert_eq!(Newline::detect("a\nb\nc"), Newline::Lf);
        assert_eq!(Newline::detect("no newlines at all"), Newline::Lf);
        // Mixed, mostly LF: treated as LF rather than converting the majority.
        assert_eq!(Newline::detect("a\r\nb\nc\nd\n"), Newline::Lf);
    }

    /// The guarantee the whole module exists for: a model returns LF and the file keeps its CRLF.
    #[test]
    fn a_crlf_file_survives_a_round_trip_through_lf_space() {
        let original = "line one\r\nline two\r\n";
        let decoded = decode_for_edit(original.as_bytes(), Path::new("f.txt")).unwrap();
        assert_eq!(decoded.text, "line one\nline two\n");
        assert_eq!(decoded.newline, Newline::Crlf);
        let bytes = encode(&decoded.text, decoded.newline, decoded.has_bom);
        assert_eq!(String::from_utf8(bytes).unwrap(), original);
    }

    #[test]
    fn a_bom_is_stripped_for_editing_and_restored_on_write() {
        let mut bytes = vec![0xef, 0xbb, 0xbf];
        bytes.extend_from_slice(b"hello\n");
        let decoded = decode_for_edit(&bytes, Path::new("f.txt")).unwrap();
        assert!(decoded.has_bom);
        assert_eq!(decoded.text, "hello\n", "the BOM must not appear in the editing text");
        assert_eq!(encode(&decoded.text, decoded.newline, decoded.has_bom), bytes);
    }

    /// Decoding these as UTF-8 would replace their characters with U+FFFD and the write would destroy the file.
    #[test]
    fn a_non_utf8_file_is_refused_with_the_encoding_named() {
        let utf16 = [0xff, 0xfe, b'h', 0, b'i', 0];
        let err = decode_for_edit(&utf16, Path::new("f.txt")).expect_err("UTF-16 must be refused");
        assert_eq!(err.code, "tool.not_utf8");
        assert!(err.message.contains("UTF-16"), "{}", err.message);

        // A lone 0xFF is not valid UTF-8 and is not a BOM either.
        let gbk = [b'a', 0xc4, 0xe3, b'b'];
        let err = decode_for_edit(&gbk, Path::new("f.txt")).expect_err("invalid UTF-8 must be refused");
        assert_eq!(err.code, "tool.not_utf8");
        assert!(err.message.contains("GBK"), "{}", err.message);
    }

    #[test]
    fn an_identical_text_produces_no_diff_at_all() {
        assert_eq!(unified_diff("same\n", "same\n"), "");
    }

    #[test]
    fn a_changed_line_appears_as_a_deletion_and_an_addition() {
        let diff = unified_diff("a\nb\nc\n", "a\nB\nc\n");
        assert!(diff.contains("-b"), "{diff}");
        assert!(diff.contains("+B"), "{diff}");
        assert!(diff.contains(" a"), "context should be included: {diff}");
        assert!(diff.starts_with("\n\n```diff"), "{diff}");
    }

    #[test]
    fn an_addition_at_the_end_is_reported() {
        let diff = unified_diff("a\n", "a\nb\n");
        assert!(diff.contains("+b"), "{diff}");
    }

    /// Far-apart edits are separate hunks; near ones merge, or they render as duplicated context.
    #[test]
    fn distant_changes_produce_separate_hunks() {
        let before: String = (0..40).map(|i| format!("line {i}\n")).collect();
        let after = before.replace("line 1\n", "CHANGED 1\n").replace("line 38\n", "CHANGED 38\n");
        let diff = unified_diff(&before, &after);
        assert_eq!(diff.matches("@@").count(), 4, "expected two hunks (two markers each): {diff}");
    }

    #[test]
    fn adjacent_changes_are_merged_into_one_hunk() {
        let before = "a\nb\nc\nd\ne\n";
        let after = "a\nB\nc\nD\ne\n";
        let diff = unified_diff(before, after);
        assert_eq!(diff.matches("@@").count(), 2, "expected one hunk: {diff}");
    }
}
