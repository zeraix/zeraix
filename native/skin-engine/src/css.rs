//! What a package's stylesheets may contain.
//!
//! `tokens.css` is loaded into the app as a real stylesheet, so unlike the manifest it is not data
//! the app interprets — the browser does. The rules here close the two ways a stylesheet can reach
//! outside the package: `@import` and `url()` pointing at a remote host (a tracking beacon, or a font
//! swapped for one the author no longer controls), and the legacy engines' script hooks
//! (`expression()`, `-moz-binding`, `behavior:`). Everything else — any selector, any property — is
//! allowed: the point of v2 skins is that authors write the CSS.
//!
//! The same check runs over every `.css` entry, not just tokens.css: an extra stylesheet cannot be
//! loaded today, but a rule that only protects one filename is a rule that stops working the day a
//! second one is linked.

use std::fmt;

/// A `url()` inside the package may only point into its own `assets/` directory, spelled either
/// relative to the stylesheet (`assets/x.png`, `./assets/x.png`) or through the protocol alias.
const ALLOWED_URL_PREFIXES: &[&str] = &["assets/", "./assets/", "skin://current/assets/"];

const FORBIDDEN_TOKENS: &[(&str, &str)] = &[
    ("@import", "@import is not allowed; put every rule in tokens.css"),
    ("expression(", "expression() is not allowed"),
    ("-moz-binding", "-moz-binding is not allowed"),
    ("behavior:", "behavior: is not allowed"),
    ("javascript:", "javascript: URLs are not allowed"),
    ("@namespace", "@namespace is not allowed"),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CssViolation {
    pub reason: String,
    /// The offending snippet, for the error detail.
    pub snippet: String,
}

impl fmt::Display for CssViolation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.reason, self.snippet)
    }
}

fn strip_comments(css: &str) -> String {
    // A forbidden token inside a comment is harmless, but a comment that never closes would hide
    // the rest of the file from this check while the browser still parses it. So comments are
    // removed only when they close; an unterminated one leaves the text as-is (and gets checked).
    let mut out = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(start) = rest.find("/*") {
        out.push_str(&rest[..start]);
        match rest[start + 2..].find("*/") {
            Some(end) => rest = &rest[start + 2 + end + 2..],
            None => {
                out.push_str(&rest[start..]);
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

fn snippet_at(text: &str, at: usize) -> String {
    let end = text[at..].char_indices().nth(60).map(|(i, _)| at + i).unwrap_or(text.len());
    text[at..end].trim().to_string()
}

/// Check one stylesheet. `Ok(())` means it may be extracted.
pub fn check_stylesheet(css: &str) -> Result<(), CssViolation> {
    let text = strip_comments(css);
    let lower = text.to_ascii_lowercase();

    for (token, reason) in FORBIDDEN_TOKENS {
        if let Some(at) = lower.find(token) {
            return Err(CssViolation { reason: (*reason).to_string(), snippet: snippet_at(&text, at) });
        }
    }

    // Every url(...) must point inside assets/. Whitespace and quotes around the argument are the
    // author's choice; the scheme and the first path segment are not.
    let mut from = 0;
    while let Some(rel) = lower[from..].find("url(") {
        let open = from + rel + 4;
        let close = match lower[open..].find(')') {
            Some(c) => open + c,
            None => {
                return Err(CssViolation { reason: "unterminated url()".into(), snippet: snippet_at(&text, from + rel) });
            }
        };
        let arg = lower[open..close].trim().trim_matches(|c| c == '"' || c == '\'').trim();
        let allowed = ALLOWED_URL_PREFIXES.iter().any(|p| arg.starts_with(p)) && !arg.contains("..");
        if !allowed {
            return Err(CssViolation {
                reason: "url() may only reference files under assets/".into(),
                snippet: snippet_at(&text, from + rel),
            });
        }
        from = close + 1;
    }
    Ok(())
}

/// SVG is an image for the gallery and for the Image primitive, both of which render it inert.
/// A crafted SVG opened any other way could still run script on the skin:// origin, so the file
/// is refused outright if it carries any — the package loses nothing a picture needs.
pub fn check_svg(svg: &str) -> Result<(), CssViolation> {
    let lower = svg.to_ascii_lowercase();
    let checks: &[(&str, &str)] = &[
        ("<script", "SVG files may not contain <script>"),
        ("javascript:", "SVG files may not contain javascript: URLs"),
        ("<foreignobject", "SVG files may not contain <foreignObject>"),
        ("<iframe", "SVG files may not contain <iframe>"),
        ("<embed", "SVG files may not contain <embed>"),
        ("<object", "SVG files may not contain <object>"),
        ("http://", "SVG files may not reference remote resources"),
        ("https://", "SVG files may not reference remote resources"),
        ("<!entity", "SVG files may not declare entities"),
    ];
    for (token, reason) in checks {
        if let Some(at) = lower.find(token) {
            // The xmlns declarations are URLs too, and every SVG has them.
            if (*token == "http://" || *token == "https://") && is_namespace_url(&lower, at) {
                let mut from = at;
                loop {
                    from += token.len();
                    match lower[from..].find(token) {
                        Some(next) if is_namespace_url(&lower, from + next) => from += next,
                        Some(next) => return Err(CssViolation { reason: (*reason).to_string(), snippet: snippet_at(svg, from + next) }),
                        None => break,
                    }
                }
                continue;
            }
            return Err(CssViolation { reason: (*reason).to_string(), snippet: snippet_at(svg, at) });
        }
    }
    // Event handler attributes: onload="...", onclick="...".
    let bytes = lower.as_bytes();
    let mut i = 0;
    while let Some(rel) = lower[i..].find(" on") {
        let at = i + rel + 1;
        let mut j = at + 2;
        while j < bytes.len() && bytes[j].is_ascii_alphabetic() {
            j += 1;
        }
        let mut k = j;
        while k < bytes.len() && bytes[k].is_ascii_whitespace() {
            k += 1;
        }
        if j > at + 2 && bytes.get(k) == Some(&b'=') {
            return Err(CssViolation { reason: "SVG files may not carry event handler attributes".into(), snippet: snippet_at(svg, at) });
        }
        i = at + 2;
    }
    Ok(())
}

fn is_namespace_url(lower: &str, at: usize) -> bool {
    const NAMESPACES: &[&str] = &[
        "http://www.w3.org/2000/svg",
        "http://www.w3.org/1999/xlink",
        "http://www.w3.org/1999/xhtml",
        "http://www.w3.org/xml/1998/namespace",
        "http://creativecommons.org/ns#",
        "http://purl.org/dc/elements/1.1/",
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
        "http://www.inkscape.org/namespaces/inkscape",
        "http://sodipodi.sourceforge.net/dtd/sodipodi-0.dtd",
        "http://www.w3.org/graphics/svg/1.1/dtd/svg11.dtd",
        "http://ns.adobe.com/",
        "http://www.serif.com/",
        "https://boxy-svg.com",
    ];
    NAMESPACES.iter().any(|ns| lower[at..].starts_with(ns))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_tokens_pass() {
        let css = ":root[data-skin-package] { --primary: #0af; --radius: 12px; }\n/* a comment with @import inside */\n.dark { --ink: #fff }";
        assert!(check_stylesheet(css).is_ok());
    }

    #[test]
    fn local_asset_urls_pass_and_remote_ones_fail() {
        assert!(check_stylesheet("@font-face { src: url(assets/f.woff2) }").is_ok());
        assert!(check_stylesheet("@font-face { src: url( \"./assets/f.woff2\" ) }").is_ok());
        assert!(check_stylesheet(".x { background: url('skin://current/assets/bg.png') }").is_ok());
        assert!(check_stylesheet(".x { background: url(https://evil.example/px.gif) }").is_err());
        assert!(check_stylesheet(".x { background: URL(//evil.example/px.gif) }").is_err());
        assert!(check_stylesheet(".x { background: url(assets/../manifest.json) }").is_err());
        assert!(check_stylesheet(".x { background: url(file:///etc/passwd) }").is_err());
        assert!(check_stylesheet(".x { background: url(assets/a.png").is_err());
    }

    #[test]
    fn imports_and_script_hooks_fail() {
        assert!(check_stylesheet("@import url(https://x.example/a.css);").is_err());
        assert!(check_stylesheet("@IMPORT 'a.css';").is_err());
        assert!(check_stylesheet(".x { width: expression(alert(1)) }").is_err());
        assert!(check_stylesheet(".x { -moz-binding: url(assets/x.xml#a) }").is_err());
        assert!(check_stylesheet(".x { behavior: url(assets/x.htc) }").is_err());
        // An unterminated comment cannot hide a violation.
        assert!(check_stylesheet("/* @import url(https://x.example/a.css);").is_err());
    }

    #[test]
    fn svg_rules() {
        let ok = r##"<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><rect width="10" height="10" fill="#0af"/></svg>"##;
        assert!(check_svg(ok).is_ok());
        assert!(check_svg(r#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#).is_err());
        assert!(check_svg(r#"<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>"#).is_err());
        assert!(check_svg(r#"<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/a.png"/></svg>"#).is_err());
        assert!(check_svg(r#"<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)">x</a></svg>"#).is_err());
        assert!(check_svg(r#"<svg xmlns="http://www.w3.org/2000/svg"><g font-family="x"/></svg>"#).is_ok());
    }
}
