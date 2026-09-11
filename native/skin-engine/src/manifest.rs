//! `manifest.json`: what a skin package says about itself, and the rules it has to meet.
//!
//! The manifest is validated twice on the way in — once from the archive before anything is
//! written, and again every time the installed directory is listed — because the directory is
//! user-writable and a hand edit is untrusted input. Both paths go through [`validate_manifest`].
//!
//! The JSON keys are snake_case (`min_app_version`, `created_at`), as the prompt set spells them;
//! camelCase spellings are accepted as aliases so a package written by hand from the TypeScript
//! side still installs. The Node-API surface camelCases the *struct fields* on its own.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::is_reserved_id;

pub const ID_MIN: usize = 2;
pub const ID_MAX: usize = 40;
pub const NAME_MAX: usize = 60;
pub const DESCRIPTION_MAX: usize = 400;
pub const AUTHOR_MAX: usize = 80;
/// Where the gallery may look for a preview picture. SVG is allowed because it is only ever an
/// `<img>`, where script does not run; extract.rs still refuses SVG files that carry any.
pub const PREVIEW_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "svg"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "node", napi_derive::napi(object))]
pub struct SkinManifest {
    /// kebab-case, unique; also the directory name the package is installed under.
    pub id: String,
    pub name: String,
    pub description: String,
    pub author: String,
    /// Valid semver (`1.2.3`, `2.0.0-beta.1`).
    pub version: String,
    #[serde(default, alias = "minAppVersion", skip_serializing_if = "Option::is_none")]
    pub min_app_version: Option<String>,
    #[serde(default, alias = "maxAppVersion", skip_serializing_if = "Option::is_none")]
    pub max_app_version: Option<String>,
    /// Relative path to a preview image inside the package.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// ISO 8601 (`2026-09-11` or `2026-09-11T10:00:00Z`).
    #[serde(alias = "createdAt")]
    pub created_at: String,
}

/// Every way a manifest can be wrong. `Display` is the message a person reads; [`code`] is the
/// stable identifier the UI translates.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SkinValidationError {
    #[error("manifest.json is not valid JSON: {0}")]
    MalformedJson(String),
    #[error("manifest.json is missing the required field \"{0}\"")]
    MissingField(String),
    #[error("manifest id \"{0}\" is not kebab-case (lowercase letters, digits and single hyphens, 2-40 characters) or is reserved")]
    InvalidId(String),
    #[error("manifest version \"{0}\" is not valid semver")]
    InvalidVersion(String),
    #[error("manifest field \"{field}\" is invalid: {reason}")]
    InvalidField { field: String, reason: String },
}

impl SkinValidationError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::MalformedJson(_) => "manifestMalformed",
            Self::MissingField(_) => "manifestMissingField",
            Self::InvalidId(_) => "manifestInvalidId",
            Self::InvalidVersion(_) => "manifestInvalidVersion",
            Self::InvalidField { .. } => "manifestInvalidField",
        }
    }

    /// The offending value or field, for the UI to show beside the translated message.
    pub fn detail(&self) -> String {
        match self {
            Self::MalformedJson(d) => d.clone(),
            Self::MissingField(f) => f.clone(),
            Self::InvalidId(id) => id.clone(),
            Self::InvalidVersion(v) => v.clone(),
            Self::InvalidField { field, reason } => format!("{field}: {reason}"),
        }
    }
}

/// `[a-z0-9]+(-[a-z0-9]+)*`, 2-40 characters. Doubles as the directory name, which is why it can
/// carry no separator, dot or anything a path would interpret.
pub fn is_kebab_case(id: &str) -> bool {
    if id.len() < ID_MIN || id.len() > ID_MAX {
        return false;
    }
    let bytes = id.as_bytes();
    if bytes.first() == Some(&b'-') || bytes.last() == Some(&b'-') {
        return false;
    }
    let mut prev_hyphen = false;
    for &b in bytes {
        match b {
            b'a'..=b'z' | b'0'..=b'9' => prev_hyphen = false,
            b'-' if !prev_hyphen => prev_hyphen = true,
            _ => return false,
        }
    }
    true
}

pub fn is_valid_skin_id(id: &str) -> bool {
    is_kebab_case(id) && !is_reserved_id(id)
}

fn digits(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_digit())
}

/// A structural ISO 8601 check: `YYYY-MM-DD`, optionally `THH:MM[:SS[.fff]]` and `Z` or `±HH:MM`.
/// Structural on purpose — the value is displayed, never computed with, so a calendar library
/// would be a dependency in the trust boundary for nothing.
pub fn is_iso8601(s: &str) -> bool {
    let (date, rest) = match s.find('T') {
        Some(i) => (&s[..i], Some(&s[i + 1..])),
        None => (s, None),
    };
    let d: Vec<&str> = date.split('-').collect();
    if d.len() != 3 || !digits(d[0], 4) || !digits(d[1], 2) || !digits(d[2], 2) {
        return false;
    }
    let (month, day) = (d[1].parse::<u32>().unwrap_or(0), d[2].parse::<u32>().unwrap_or(0));
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return false;
    }
    let Some(rest) = rest else { return true };
    // Split off the zone.
    let (time, zone) = if let Some(t) = rest.strip_suffix('Z') {
        (t, "")
    } else if let Some(i) = rest.rfind(['+', '-']) {
        (&rest[..i], &rest[i..])
    } else {
        (rest, "")
    };
    if !zone.is_empty() {
        let z = &zone[1..];
        let parts: Vec<&str> = z.split(':').collect();
        if parts.len() != 2 || !digits(parts[0], 2) || !digits(parts[1], 2) {
            return false;
        }
    }
    let (hms, frac) = match time.find('.') {
        Some(i) => (&time[..i], Some(&time[i + 1..])),
        None => (time, None),
    };
    if let Some(f) = frac {
        if f.is_empty() || !f.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
    }
    let t: Vec<&str> = hms.split(':').collect();
    if !(2..=3).contains(&t.len()) || !t.iter().all(|p| digits(p, 2)) {
        return false;
    }
    let hour = t[0].parse::<u32>().unwrap_or(99);
    let minute = t[1].parse::<u32>().unwrap_or(99);
    let second = t.get(2).map(|s| s.parse::<u32>().unwrap_or(99)).unwrap_or(0);
    hour < 24 && minute < 60 && second < 61
}

/// A relative path inside the package that cannot leave it: forward slashes, no empty, `.` or `..`
/// segments, no leading slash or drive letter, no NUL, no backslash.
pub fn is_safe_relative_path(p: &str) -> bool {
    if p.is_empty() || p.len() > 255 || p.contains('\0') || p.contains('\\') || p.starts_with('/') {
        return false;
    }
    if p.as_bytes().get(1) == Some(&b':') {
        return false;
    }
    p.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

fn extension_of(p: &str) -> Option<String> {
    let name = p.rsplit('/').next()?;
    let (_, ext) = name.rsplit_once('.')?;
    if ext.is_empty() {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

const REQUIRED: &[&str] = &["id", "name", "description", "author", "version", "created_at"];

/// Every problem with the manifest, not just the first — a package author fixing a file wants
/// the whole list once. Returns the manifest only when the list is empty.
pub fn validate_manifest_report(raw: &str) -> Result<SkinManifest, Vec<SkinValidationError>> {
    let value: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => return Err(vec![SkinValidationError::MalformedJson(e.to_string())]),
    };
    let Some(obj) = value.as_object() else {
        return Err(vec![SkinValidationError::MalformedJson("the top level must be an object".into())]);
    };

    let mut errors = Vec::new();
    // Presence, with the camelCase alias honoured, before the typed decode: serde reports only the
    // first missing field, and by name in its own words.
    let has = |snake: &str, camel: &str| obj.contains_key(snake) || obj.contains_key(camel);
    for field in REQUIRED {
        let camel = match *field {
            "created_at" => "createdAt",
            other => other,
        };
        if !has(field, camel) {
            errors.push(SkinValidationError::MissingField((*field).to_string()));
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }

    let manifest: SkinManifest = match serde_json::from_value(value) {
        Ok(m) => m,
        Err(e) => return Err(vec![SkinValidationError::MalformedJson(e.to_string())]),
    };

    if !is_valid_skin_id(&manifest.id) {
        errors.push(SkinValidationError::InvalidId(manifest.id.clone()));
    }
    let name = manifest.name.trim();
    if name.is_empty() {
        errors.push(SkinValidationError::InvalidField { field: "name".into(), reason: "must not be empty".into() });
    } else if name.chars().count() > NAME_MAX {
        errors.push(SkinValidationError::InvalidField {
            field: "name".into(),
            reason: format!("longer than {NAME_MAX} characters"),
        });
    }
    if manifest.description.chars().count() > DESCRIPTION_MAX {
        errors.push(SkinValidationError::InvalidField {
            field: "description".into(),
            reason: format!("longer than {DESCRIPTION_MAX} characters"),
        });
    }
    if manifest.author.chars().count() > AUTHOR_MAX {
        errors.push(SkinValidationError::InvalidField {
            field: "author".into(),
            reason: format!("longer than {AUTHOR_MAX} characters"),
        });
    }
    if semver::Version::parse(&manifest.version).is_err() {
        errors.push(SkinValidationError::InvalidVersion(manifest.version.clone()));
    }
    for (field, value) in [("min_app_version", &manifest.min_app_version), ("max_app_version", &manifest.max_app_version)] {
        if let Some(v) = value {
            if semver::Version::parse(v).is_err() {
                errors.push(SkinValidationError::InvalidField { field: field.into(), reason: format!("\"{v}\" is not valid semver") });
            }
        }
    }
    if let (Some(min), Some(max)) = (&manifest.min_app_version, &manifest.max_app_version) {
        if let (Ok(min), Ok(max)) = (semver::Version::parse(min), semver::Version::parse(max)) {
            if min > max {
                errors.push(SkinValidationError::InvalidField {
                    field: "min_app_version".into(),
                    reason: "is greater than max_app_version".into(),
                });
            }
        }
    }
    if let Some(p) = &manifest.preview {
        if !is_safe_relative_path(p) {
            errors.push(SkinValidationError::InvalidField {
                field: "preview".into(),
                reason: "must be a relative path inside the package".into(),
            });
        } else if !extension_of(p).is_some_and(|e| PREVIEW_EXTENSIONS.contains(&e.as_str())) {
            errors.push(SkinValidationError::InvalidField {
                field: "preview".into(),
                reason: "must be a png, jpg, webp, gif or svg image".into(),
            });
        }
    }
    if !is_iso8601(&manifest.created_at) {
        errors.push(SkinValidationError::InvalidField {
            field: "created_at".into(),
            reason: "must be an ISO 8601 date such as 2026-09-11 or 2026-09-11T10:00:00Z".into(),
        });
    }

    if errors.is_empty() { Ok(manifest) } else { Err(errors) }
}

/// The manifest, or the first problem with it.
pub fn validate_manifest(raw: &str) -> Result<SkinManifest, SkinValidationError> {
    validate_manifest_report(raw).map_err(|mut errs| errs.remove(0))
}

/// Whether the running app's version satisfies the manifest's `min_app_version` / `max_app_version`.
/// An unparsable app version counts as compatible: a dev build's "0.0.0-harness" must not block installs.
pub fn is_compatible(manifest: &SkinManifest, app_version: &str) -> bool {
    let Ok(app) = semver::Version::parse(app_version) else { return true };
    if let Some(min) = manifest.min_app_version.as_deref().and_then(|v| semver::Version::parse(v).ok()) {
        if app < min {
            return false;
        }
    }
    if let Some(max) = manifest.max_app_version.as_deref().and_then(|v| semver::Version::parse(v).ok()) {
        if app > max {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn good() -> String {
        r#"{
          "id": "aurora-night",
          "name": "Aurora Night",
          "description": "Deep teal with a green glow.",
          "author": "Zeraix",
          "version": "1.2.0",
          "preview": "assets/preview.png",
          "created_at": "2026-09-11T10:00:00Z"
        }"#
        .to_string()
    }

    #[test]
    fn accepts_a_complete_manifest() {
        let m = validate_manifest(&good()).expect("valid");
        assert_eq!(m.id, "aurora-night");
        assert_eq!(m.version, "1.2.0");
        assert_eq!(m.preview.as_deref(), Some("assets/preview.png"));
        assert_eq!(m.min_app_version, None);
    }

    #[test]
    fn accepts_camel_case_aliases_and_optional_versions() {
        let raw = r#"{"id":"x-y","name":"X","description":"","author":"","version":"0.1.0",
                      "minAppVersion":"2.0.0","maxAppVersion":"3.0.0","createdAt":"2026-01-02"}"#;
        let m = validate_manifest(raw).expect("valid");
        assert_eq!(m.min_app_version.as_deref(), Some("2.0.0"));
        assert_eq!(m.created_at, "2026-01-02");
    }

    #[test]
    fn rejects_malformed_json() {
        let err = validate_manifest("{ not json").unwrap_err();
        assert!(matches!(err, SkinValidationError::MalformedJson(_)));
        assert_eq!(err.code(), "manifestMalformed");
        let err = validate_manifest("[1,2]").unwrap_err();
        assert!(matches!(err, SkinValidationError::MalformedJson(_)));
    }

    #[test]
    fn reports_every_missing_field() {
        let errs = validate_manifest_report(r#"{"id":"a-b"}"#).unwrap_err();
        let names: Vec<String> = errs
            .iter()
            .map(|e| match e {
                SkinValidationError::MissingField(f) => f.clone(),
                other => panic!("unexpected {other:?}"),
            })
            .collect();
        assert_eq!(names, ["name", "description", "author", "version", "created_at"]);
        assert_eq!(validate_manifest(r#"{"id":"a-b"}"#).unwrap_err(), SkinValidationError::MissingField("name".into()));
    }

    #[test]
    fn rejects_ids_that_are_not_kebab_case_or_are_reserved() {
        for bad in ["Aurora", "aurora_night", "-aurora", "aurora-", "aurora--night", "../evil", "a", "aurora night", "default", "current", "builtin-x"] {
            let raw = good().replace("aurora-night", bad);
            let err = validate_manifest(&raw).unwrap_err();
            assert!(matches!(err, SkinValidationError::InvalidId(ref id) if id == bad), "{bad}: {err:?}");
        }
        assert!(is_kebab_case("a1-b2-c3"));
        assert!(!is_kebab_case(&"a".repeat(41)));
    }

    #[test]
    fn rejects_versions_that_are_not_semver() {
        for bad in ["1.2", "v1.2.3", "latest", "1.2.3.4", ""] {
            let raw = good().replace("\"1.2.0\"", &format!("\"{bad}\""));
            let err = validate_manifest(&raw).unwrap_err();
            assert!(matches!(err, SkinValidationError::InvalidVersion(ref v) if v == bad), "{bad}: {err:?}");
        }
    }

    #[test]
    fn rejects_bad_app_version_bounds_previews_and_dates() {
        let raw = good().replace("\"preview\": \"assets/preview.png\"", "\"preview\": \"../../etc/passwd\"");
        let err = validate_manifest(&raw).unwrap_err();
        assert!(matches!(err, SkinValidationError::InvalidField { ref field, .. } if field == "preview"));

        let raw = good().replace("\"preview\": \"assets/preview.png\"", "\"preview\": \"assets/preview.exe\"");
        assert!(matches!(validate_manifest(&raw).unwrap_err(), SkinValidationError::InvalidField { .. }));

        let raw = good().replace("2026-09-11T10:00:00Z", "yesterday");
        let err = validate_manifest(&raw).unwrap_err();
        assert!(matches!(err, SkinValidationError::InvalidField { ref field, .. } if field == "created_at"));

        let raw = good().replace("\"version\": \"1.2.0\",", "\"version\": \"1.2.0\", \"min_app_version\": \"3.0.0\", \"max_app_version\": \"2.0.0\",");
        let errs = validate_manifest_report(&raw).unwrap_err();
        assert!(errs.iter().any(|e| matches!(e, SkinValidationError::InvalidField { field, .. } if field == "min_app_version")));

        let raw = good().replace("\"version\": \"1.2.0\",", "\"version\": \"1.2.0\", \"min_app_version\": \"soon\",");
        assert!(matches!(validate_manifest(&raw).unwrap_err(), SkinValidationError::InvalidField { .. }));
    }

    #[test]
    fn iso8601_shapes() {
        for ok in ["2026-09-11", "2026-09-11T10:00", "2026-09-11T10:00:00", "2026-09-11T10:00:00Z", "2026-09-11T10:00:00.123Z", "2026-09-11T10:00:00+08:00"] {
            assert!(is_iso8601(ok), "{ok}");
        }
        for bad in ["", "2026", "2026-13-01", "2026-09-32", "2026-09-11T25:00", "2026-09-11T10", "2026-09-11T10:00:00+8", "11/09/2026"] {
            assert!(!is_iso8601(bad), "{bad}");
        }
    }

    #[test]
    fn compatibility_window() {
        let mut m = validate_manifest(&good()).unwrap();
        assert!(is_compatible(&m, "2.0.0"));
        m.min_app_version = Some("2.1.0".into());
        assert!(!is_compatible(&m, "2.0.0"));
        assert!(is_compatible(&m, "2.1.0"));
        m.max_app_version = Some("2.5.0".into());
        assert!(!is_compatible(&m, "3.0.0"));
        assert!(is_compatible(&m, "0.0.0-harness") || is_compatible(&m, "not-a-version"));
    }

    #[test]
    fn safe_relative_paths() {
        for ok in ["a.png", "assets/a.png", "assets/deep/er/a.svg"] {
            assert!(is_safe_relative_path(ok), "{ok}");
        }
        for bad in ["", "/a.png", "../a.png", "assets/../a.png", "assets//a.png", "./a.png", "C:/a.png", "a\\b.png", "a\0.png"] {
            assert!(!is_safe_relative_path(bad), "{bad}");
        }
    }
}
