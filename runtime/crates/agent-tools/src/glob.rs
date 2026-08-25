//! Glob → regex translation, mirroring `globToRegExp` in aiToolkit.mjs exactly.
//!
//! The JS version is eight lines and its semantics are load-bearing for `search_files` and the
//! `pattern` filter on `search_in_files`: `*` does not cross a `/`, `?` is exactly one non-`/`
//! character, the match is anchored at both ends, and it is case-insensitive. Anything richer (globset,
//! `**`) would find files the JS path does not, which is a behaviour change, not a fix.

use agent_core::{Result, RuntimeError};
use regex::Regex;

/// Characters the JS implementation escapes verbatim. Kept as the same literal set so a future reader
/// can diff the two lists rather than reason about two different escaping strategies.
const ESCAPED: &str = "\\^$.|+()[]{}";

/// Compile a glob into an anchored, case-insensitive regex.
pub fn glob_to_regex(glob: &str) -> Result<Regex> {
    let mut re = String::with_capacity(glob.len() * 2);
    for ch in glob.chars() {
        match ch {
            '*' => re.push_str("[^/]*"),
            '?' => re.push_str("[^/]"),
            c if ESCAPED.contains(c) => {
                re.push('\\');
                re.push(c);
            }
            c => re.push(c),
        }
    }
    Regex::new(&format!("(?i)^{re}$"))
        .map_err(|e| RuntimeError::invalid("tool.invalid_glob", format!("invalid pattern: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn star_does_not_cross_separator() {
        let re = glob_to_regex("*.rs").unwrap();
        assert!(re.is_match("main.rs"));
        assert!(!re.is_match("src/main.rs"));
    }

    #[test]
    fn question_is_exactly_one() {
        let re = glob_to_regex("a?c").unwrap();
        assert!(re.is_match("abc"));
        assert!(!re.is_match("ac"));
        assert!(!re.is_match("abbc"));
    }

    #[test]
    fn is_case_insensitive_and_anchored() {
        let re = glob_to_regex("readme.md").unwrap();
        assert!(re.is_match("README.MD"));
        assert!(!re.is_match("xreadme.md"));
    }

    #[test]
    fn regex_metacharacters_are_literal() {
        let re = glob_to_regex("a+b.c").unwrap();
        assert!(re.is_match("a+b.c"));
        assert!(!re.is_match("aab.c"));
        assert!(!re.is_match("a+bxc"));
    }
}
