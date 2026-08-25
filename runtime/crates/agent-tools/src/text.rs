//! UTF-16 aware string helpers.
//!
//! Not pedantry. The JS handlers being replaced measure and slice with `String.prototype.length` and
//! `.slice()`, which count **UTF-16 code units**, while Rust's `str::len()` counts **bytes**. For a
//! source file of ASCII the two agree; for a file containing CJK text they do not, and a `read_file`
//! that trims at "200,000" would trim at a different place in each runtime. The A/B harness would
//! catch it, but only on a file someone thought to test with — so the conversion lives here instead.

/// Length in UTF-16 code units, as JavaScript's `String.prototype.length` reports it.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// Take the first `max` UTF-16 code units, as JavaScript's `.slice(0, max)` would.
///
/// One deliberate divergence: JS can split a surrogate pair and produce a lone surrogate, which is not
/// representable in a Rust `String`. When the cut would land mid-pair we stop *before* the pair, so the
/// result is at most one code unit shorter than JS would produce. That only differs on an astral-plane
/// character (emoji, rare CJK) sitting exactly on the boundary.
pub fn utf16_truncate(s: &str, max: usize) -> &str {
    let mut units = 0usize;
    for (byte_idx, ch) in s.char_indices() {
        let next = units + ch.len_utf16();
        if next > max {
            return &s[..byte_idx];
        }
        units = next;
    }
    s
}

/// `s.length > max ? s.slice(0, max) + "…" : s` — the per-line clip used by `search_in_files`.
pub fn clip(s: &str, max: usize) -> String {
    if utf16_len(s) > max {
        format!("{}…", utf16_truncate(s, max))
    } else {
        s.to_owned()
    }
}

/// Order two names the way `Intl`-backed `String.prototype.localeCompare` does for the cases that
/// actually occur in a directory listing.
///
/// **This is an approximation and is the one known parity risk in `list_directory`.** Node's
/// `localeCompare` is full ICU collation; reimplementing it would mean vendoring a collation table.
/// What is reproduced here is the part that changes observable output on real directories: ICU orders
/// case-insensitively first (`a` before `B`, where a byte comparison would give `B` before `a`) and
/// uses case only to break an otherwise exact tie, lowercase first.
///
/// Names differing only by non-ASCII punctuation may still order differently from Node. The A/B
/// harness compares real trees precisely so that any such case shows up as a diff rather than as a
/// subtly reordered listing nobody notices.
pub fn locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    // Compared lazily rather than by folding both sides into `Vec<char>` first. The allocating version
    // ran on every comparison, so sorting one 320-entry directory allocated some five thousand vectors
    // and made `list_directory` measurably slower than the Node handler it replaces. Almost all
    // comparisons decide on the first character or two, so this returns before allocating anything.
    let mut ai = a.chars().flat_map(char::to_lowercase);
    let mut bi = b.chars().flat_map(char::to_lowercase);
    loop {
        match (ai.next(), bi.next()) {
            (None, None) => break,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) if x != y => return x.cmp(&y),
            (Some(_), Some(_)) => {}
        }
    }
    // Exact tie under folding: ICU puts the lowercase form first.
    let uppers = |s: &str| s.chars().filter(|c| c.is_uppercase()).count();
    uppers(a).cmp(&uppers(b)).then_with(|| a.cmp(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_len_counts_code_units() {
        assert_eq!(utf16_len("abc"), 3);
        assert_eq!(utf16_len("中文"), 2); // BMP: one unit each
        assert_eq!(utf16_len("😀"), 2); // astral: surrogate pair
    }

    #[test]
    fn truncate_never_splits_a_pair() {
        assert_eq!(utf16_truncate("ab😀", 3), "ab");
        assert_eq!(utf16_truncate("ab😀", 4), "ab😀");
        assert_eq!(utf16_truncate("abc", 10), "abc");
    }

    #[test]
    fn clip_appends_ellipsis_only_when_over() {
        assert_eq!(clip("abcdef", 3), "abc…");
        assert_eq!(clip("abc", 3), "abc");
    }

    #[test]
    fn locale_compare_is_case_insensitive_first() {
        use std::cmp::Ordering::*;
        // The case a byte comparison gets wrong.
        assert_eq!(locale_compare("a", "B"), Less);
        assert_eq!(locale_compare("README.md", "src"), Less);
        // Case only breaks an exact tie, lowercase first.
        assert_eq!(locale_compare("a", "A"), Less);
        assert_eq!(locale_compare("abc", "abc"), Equal);
    }
}
