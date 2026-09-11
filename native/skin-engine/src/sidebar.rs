//! `sidebar.json`: data-only customization of everything the sidebar draws.
//!
//! A package may replace the brand images, reorder / relabel / re-icon / hide the nav items, relabel
//! or hide the project tree, re-icon its folders, and re-icon / relabel the header controls and the
//! account menu. It may not hide a control or a menu entry: Settings always stays reachable, so no
//! package can lock a person into itself.
//!
//! Every id is checked against the lists the app passes in ([`SidebarRegistry`], built from
//! electron/skins/layoutRefs.mjs), every built-in icon name against the app's icon set, and every
//! image path against the files actually in the archive -- a sidebar that points at an image the
//! package does not ship is refused at install time rather than rendering a broken image later.
//! The renderer's zod twin is src/components/theme/skinpkg/sidebarSchema.ts; change one, change both.

use std::collections::{BTreeMap, HashSet};

use serde::Deserialize;
use thiserror::Error;

use crate::manifest::is_safe_relative_path;

pub const LABEL_MAX: usize = 40;
pub const LOCALES_MAX: usize = 16;
pub const LOGO_HEIGHT_MIN: f64 = 12.0;
pub const LOGO_HEIGHT_MAX: f64 = 40.0;
pub const ICON_PREFIX: &str = "icon:";
pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "svg"];
pub const MAX_VALUE_LEN: usize = 200;

/// What the app renders, passed in by the app. An empty list means "nothing of that kind exists":
/// a sidebar.json naming one is refused.
#[derive(Debug, Clone, Default)]
pub struct SidebarRegistry {
    pub nav_items: Vec<String>,
    pub sections: Vec<String>,
    pub controls: Vec<String>,
    pub menu: Vec<String>,
    pub icons: Vec<String>,
}

/// A label: plain text, or text per locale with an optional `default`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum Label {
    Text(String),
    Localized(BTreeMap<String, String>),
}

/// One customizable thing: a nav item, a section, a control or a menu entry. Which fields are
/// allowed depends on the group (see [`validate_sidebar`]).
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SlotItem {
    pub icon: Option<String>,
    pub active_icon: Option<String>,
    pub icon_dark: Option<String>,
    pub active_icon_dark: Option<String>,
    pub label: Option<Label>,
    pub hidden: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Brand {
    /// The wordmark at the top of the sidebar.
    pub logo: Option<String>,
    pub logo_dark: Option<String>,
    /// The square app logo: home screen, title bar, sign-in dialog.
    pub mark: Option<String>,
    pub mark_dark: Option<String>,
    pub height: Option<f64>,
    pub hidden: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Nav {
    #[serde(default)]
    pub order: Vec<String>,
    #[serde(default)]
    pub items: BTreeMap<String, SlotItem>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Tree {
    pub folder_icon: Option<String>,
    pub folder_open_icon: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SidebarConfig {
    pub version: Option<u32>,
    pub brand: Option<Brand>,
    pub nav: Option<Nav>,
    #[serde(default)]
    pub sections: BTreeMap<String, SlotItem>,
    pub tree: Option<Tree>,
    #[serde(default)]
    pub controls: BTreeMap<String, SlotItem>,
    #[serde(default)]
    pub menu: BTreeMap<String, SlotItem>,
}

#[derive(Debug, Clone, PartialEq, Error)]
pub enum SidebarValidationError {
    #[error("sidebar.json is not valid: {0}")]
    Malformed(String),
    #[error("sidebar.json names {group} \"{id}\", which the app does not have")]
    UnknownId { group: String, id: String },
    #[error("sidebar.json field \"{field}\" is not allowed: {reason}")]
    NotAllowed { field: String, reason: String },
    #[error("sidebar.json field \"{field}\" has an invalid icon \"{value}\": {reason}")]
    InvalidIcon { field: String, value: String, reason: String },
    #[error("sidebar.json field \"{field}\" points at \"{path}\", which is not in the package")]
    MissingAsset { field: String, path: String },
    #[error("sidebar.json field \"{field}\" is invalid: {reason}")]
    InvalidValue { field: String, reason: String },
}

impl SidebarValidationError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Malformed(_) => "sidebarMalformed",
            Self::UnknownId { .. } => "sidebarUnknownId",
            Self::NotAllowed { .. } => "sidebarNotAllowed",
            Self::InvalidIcon { .. } => "sidebarInvalidIcon",
            Self::MissingAsset { .. } => "sidebarMissingAsset",
            Self::InvalidValue { .. } => "sidebarInvalidValue",
        }
    }
}

type SResult<T> = Result<T, SidebarValidationError>;
type HasFile<'a> = &'a dyn Fn(&str) -> bool;

/// `assets/<path>.<image extension>`, in the charset the renderer's asset schema accepts.
pub fn is_asset_image_path(v: &str) -> bool {
    v.len() <= MAX_VALUE_LEN
        && v.starts_with("assets/")
        && !v.contains("..")
        && is_safe_relative_path(v)
        && v.chars().all(|c| c.is_ascii_alphanumeric() || "_-./".contains(c))
        && v.rsplit_once('.').is_some_and(|(stem, ext)| !stem.ends_with('/') && IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// `default`, `en`, `zh-TW`: the shapes a locale key may take.
pub fn is_locale_key(k: &str) -> bool {
    if k == "default" {
        return true;
    }
    let b = k.as_bytes();
    match b.len() {
        2 => b.iter().all(u8::is_ascii_lowercase),
        5 => b[0].is_ascii_lowercase() && b[1].is_ascii_lowercase() && b[2] == b'-' && b[3].is_ascii_uppercase() && b[4].is_ascii_uppercase(),
        _ => false,
    }
}

fn check_image(field: &str, v: &str, has_file: HasFile) -> SResult<()> {
    if !is_asset_image_path(v) {
        return Err(SidebarValidationError::InvalidIcon {
            field: field.into(),
            value: v.into(),
            reason: "must be a png, jpg, webp, gif or svg under assets/".into(),
        });
    }
    if !has_file(v) {
        return Err(SidebarValidationError::MissingAsset { field: field.into(), path: v.into() });
    }
    Ok(())
}

fn check_icon(field: &str, v: &str, reg: &SidebarRegistry, has_file: HasFile) -> SResult<()> {
    if let Some(name) = v.strip_prefix(ICON_PREFIX) {
        if !reg.icons.iter().any(|i| i == name) {
            return Err(SidebarValidationError::InvalidIcon { field: field.into(), value: v.into(), reason: "not a built-in icon name".into() });
        }
        return Ok(());
    }
    check_image(field, v, has_file)
}

fn check_text(field: &str, s: &str) -> SResult<()> {
    let t = s.trim();
    let reason = if t.is_empty() {
        Some("must not be empty".to_string())
    } else if t.chars().count() > LABEL_MAX {
        Some(format!("longer than {LABEL_MAX} characters"))
    } else if s.chars().any(char::is_control) {
        Some("must be plain text".to_string())
    } else {
        None
    };
    match reason {
        Some(reason) => Err(SidebarValidationError::InvalidValue { field: field.into(), reason }),
        None => Ok(()),
    }
}

fn check_label(field: &str, label: &Label) -> SResult<()> {
    match label {
        Label::Text(s) => check_text(field, s),
        Label::Localized(map) => {
            if map.is_empty() || map.len() > LOCALES_MAX {
                return Err(SidebarValidationError::InvalidValue { field: field.into(), reason: format!("a localized label needs 1-{LOCALES_MAX} entries") });
            }
            for (k, v) in map {
                if !is_locale_key(k) {
                    return Err(SidebarValidationError::InvalidValue { field: field.into(), reason: format!("\"{k}\" is not a locale code such as en, zh-TW or default") });
                }
                check_text(&format!("{field}.{k}"), v)?;
            }
            Ok(())
        }
    }
}

struct Rules {
    group: &'static str,
    allow_hidden: bool,
    allow_active: bool,
}

fn check_group(rules: &Rules, map: &BTreeMap<String, SlotItem>, known: &[String], reg: &SidebarRegistry, has_file: HasFile) -> SResult<()> {
    for (id, item) in map {
        if !known.iter().any(|k| k == id) {
            return Err(SidebarValidationError::UnknownId { group: rules.group.into(), id: id.clone() });
        }
        let base = format!("{}.{id}", rules.group);
        if item.hidden.is_some() && !rules.allow_hidden {
            return Err(SidebarValidationError::NotAllowed {
                field: format!("{base}.hidden"),
                reason: "only nav items and sections can be hidden; controls and the account menu always stay reachable".into(),
            });
        }
        if !rules.allow_active && (item.active_icon.is_some() || item.active_icon_dark.is_some()) {
            return Err(SidebarValidationError::NotAllowed { field: format!("{base}.activeIcon"), reason: "only nav items have an active state".into() });
        }
        for (name, v) in [("icon", &item.icon), ("iconDark", &item.icon_dark), ("activeIcon", &item.active_icon), ("activeIconDark", &item.active_icon_dark)] {
            if let Some(v) = v {
                check_icon(&format!("{base}.{name}"), v, reg, has_file)?;
            }
        }
        if let Some(label) = &item.label {
            check_label(&format!("{base}.label"), label)?;
        }
    }
    Ok(())
}

/// Parse and check sidebar.json. `has_file` answers whether a package-relative path is in the archive.
pub fn validate_sidebar(raw: &str, reg: &SidebarRegistry, has_file: HasFile) -> SResult<SidebarConfig> {
    let config: SidebarConfig = serde_json::from_str(raw).map_err(|e| SidebarValidationError::Malformed(e.to_string()))?;

    if let Some(b) = &config.brand {
        for (field, v) in [("brand.logo", &b.logo), ("brand.logoDark", &b.logo_dark), ("brand.mark", &b.mark), ("brand.markDark", &b.mark_dark)] {
            if let Some(v) = v {
                check_image(field, v, has_file)?;
            }
        }
        if let Some(h) = b.height {
            if !h.is_finite() || !(LOGO_HEIGHT_MIN..=LOGO_HEIGHT_MAX).contains(&h) {
                return Err(SidebarValidationError::InvalidValue { field: "brand.height".into(), reason: format!("must be {LOGO_HEIGHT_MIN}-{LOGO_HEIGHT_MAX}") });
            }
        }
    }

    if let Some(nav) = &config.nav {
        let mut seen = HashSet::new();
        for id in &nav.order {
            if !reg.nav_items.iter().any(|k| k == id) {
                return Err(SidebarValidationError::UnknownId { group: "nav".into(), id: id.clone() });
            }
            if !seen.insert(id) {
                return Err(SidebarValidationError::InvalidValue { field: "nav.order".into(), reason: format!("\"{id}\" is listed twice") });
            }
        }
        check_group(&Rules { group: "nav", allow_hidden: true, allow_active: true }, &nav.items, &reg.nav_items, reg, has_file)?;
    }
    check_group(&Rules { group: "sections", allow_hidden: true, allow_active: false }, &config.sections, &reg.sections, reg, has_file)?;
    check_group(&Rules { group: "controls", allow_hidden: false, allow_active: false }, &config.controls, &reg.controls, reg, has_file)?;
    check_group(&Rules { group: "menu", allow_hidden: false, allow_active: false }, &config.menu, &reg.menu, reg, has_file)?;

    if let Some(t) = &config.tree {
        for (field, v) in [("tree.folderIcon", &t.folder_icon), ("tree.folderOpenIcon", &t.folder_open_icon)] {
            if let Some(v) = v {
                check_icon(field, v, reg, has_file)?;
            }
        }
    }
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reg() -> SidebarRegistry {
        let v = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect();
        SidebarRegistry {
            nav_items: v(&["new-chat", "skills", "automation", "models", "plugins", "library"]),
            sections: v(&["projects"]),
            controls: v(&["collapse", "expand", "pin", "userMenu"]),
            menu: v(&["settings", "help", "language", "theme", "wallet", "logout", "signIn"]),
            icons: v(&["sparkles", "folder", "settings", "zap"]),
        }
    }

    const FILES: &[&str] = &["assets/logo.svg", "assets/logo-dark.svg", "assets/nav/chat.svg", "assets/nav/chat-on.png"];

    fn has(p: &str) -> bool {
        FILES.contains(&p)
    }

    fn check(json: &str) -> SResult<SidebarConfig> {
        validate_sidebar(json, &reg(), &has)
    }

    #[test]
    fn accepts_a_full_config() {
        let c = check(
            r#"{
              "version": 1,
              "brand": { "logo": "assets/logo.svg", "logoDark": "assets/logo-dark.svg", "mark": "assets/logo.svg", "height": 20, "hidden": false },
              "nav": {
                "order": ["library", "new-chat"],
                "items": {
                  "new-chat": { "icon": "assets/nav/chat.svg", "activeIcon": "assets/nav/chat-on.png", "iconDark": "icon:sparkles", "activeIconDark": "icon:zap",
                                "label": { "default": "Chat", "zh": "对话", "zh-TW": "對話" } },
                  "plugins": { "hidden": true }
                }
              },
              "sections": { "projects": { "label": "Workspaces", "hidden": false } },
              "tree": { "folderIcon": "icon:folder", "folderOpenIcon": "assets/nav/chat.svg" },
              "controls": { "collapse": { "icon": "icon:zap", "label": "Hide" }, "userMenu": { "icon": "icon:settings" } },
              "menu": { "settings": { "icon": "icon:settings", "label": { "default": "Preferences" } }, "signIn": { "icon": "assets/logo.svg" } }
            }"#,
        )
        .expect("valid");
        assert_eq!(c.nav.as_ref().unwrap().order, ["library", "new-chat"]);
        assert_eq!(c.nav.unwrap().items["new-chat"].label, Some(Label::Localized([("default".into(), "Chat".into()), ("zh".into(), "对话".into()), ("zh-TW".into(), "對話".into())].into())));
        assert!(check("{}").is_ok());
    }

    #[test]
    fn unknown_fields_are_refused_by_the_schema() {
        for bad in [r#"{"script":"x"}"#, r#"{"nav":{"items":{"new-chat":{"onClick":"alert(1)"}}}}"#, r#"{"brand":{"style":"x"}}"#, r#"{"tree":{"href":"x"}}"#, "[]", "{"] {
            assert!(matches!(check(bad).unwrap_err(), SidebarValidationError::Malformed(_)), "{bad}");
        }
        // A localized label whose value is not text does not match either label shape.
        assert!(matches!(check(r#"{"sections":{"projects":{"label":{"en":5}}}}"#).unwrap_err(), SidebarValidationError::Malformed(_)));
    }

    #[test]
    fn ids_must_be_ones_the_app_renders() {
        for (bad, group) in [
            (r#"{"nav":{"items":{"weather":{}}}}"#, "nav"),
            (r#"{"nav":{"order":["weather"]}}"#, "nav"),
            (r#"{"sections":{"conversations":{}}}"#, "sections"),
            (r#"{"controls":{"close":{}}}"#, "controls"),
            (r#"{"menu":{"__proto__":{}}}"#, "menu"),
        ] {
            let err = check(bad).unwrap_err();
            assert!(matches!(err, SidebarValidationError::UnknownId { group: ref g, .. } if g == group), "{bad}: {err}");
            assert_eq!(err.code(), "sidebarUnknownId");
        }
        let err = check(r#"{"nav":{"order":["skills","skills"]}}"#).unwrap_err();
        assert!(matches!(err, SidebarValidationError::InvalidValue { .. }), "{err}");
    }

    #[test]
    fn controls_and_menu_cannot_be_hidden_and_only_nav_has_active_icons() {
        for bad in [r#"{"menu":{"settings":{"hidden":true}}}"#, r#"{"menu":{"logout":{"hidden":false}}}"#, r#"{"controls":{"expand":{"hidden":true}}}"#] {
            let err = check(bad).unwrap_err();
            assert!(matches!(err, SidebarValidationError::NotAllowed { .. }), "{bad}: {err}");
            assert_eq!(err.code(), "sidebarNotAllowed");
        }
        for bad in [r#"{"sections":{"projects":{"activeIcon":"icon:zap"}}}"#, r#"{"menu":{"help":{"activeIconDark":"icon:zap"}}}"#] {
            assert!(matches!(check(bad).unwrap_err(), SidebarValidationError::NotAllowed { .. }), "{bad}");
        }
        assert!(check(r#"{"sections":{"projects":{"hidden":true}}}"#).is_ok());
    }

    #[test]
    fn icons_are_builtin_names_or_package_images_that_exist() {
        for bad in [
            "icon:not-an-icon",
            "icon:",
            "assets/../manifest.json",
            "assets/a..b.svg",
            "../assets/nav/chat.svg",
            "/assets/nav/chat.svg",
            "assets\\nav\\chat.svg",
            "https://tracker.example/pixel.svg",
            "data:image/svg+xml,<svg/>",
            "assets/nav/chat.exe",
            "assets/nav/.svg",
            "assets/nav/chat svg.svg",
            "tokens.css",
        ] {
            let json = format!(r#"{{"nav":{{"items":{{"skills":{{"icon":{}}}}}}}}}"#, serde_json::to_string(bad).unwrap());
            let err = check(&json).unwrap_err();
            assert!(matches!(err, SidebarValidationError::InvalidIcon { .. }), "{bad}: {err}");
        }
        let err = check(r#"{"menu":{"help":{"icon":"assets/nav/missing.svg"}}}"#).unwrap_err();
        assert!(matches!(err, SidebarValidationError::MissingAsset { ref path, .. } if path == "assets/nav/missing.svg"), "{err}");
        assert_eq!(err.code(), "sidebarMissingAsset");
        // Brand images are images: a built-in icon name is not a logo.
        assert!(matches!(check(r#"{"brand":{"logo":"icon:sparkles"}}"#).unwrap_err(), SidebarValidationError::InvalidIcon { .. }));
        assert!(matches!(check(r#"{"brand":{"mark":"assets/nope.svg"}}"#).unwrap_err(), SidebarValidationError::MissingAsset { .. }));
        assert!(check(r#"{"tree":{"folderIcon":"assets/nav/chat-on.png"}}"#).is_ok());
        assert!(matches!(check(r#"{"tree":{"folderOpenIcon":"icon:nope"}}"#).unwrap_err(), SidebarValidationError::InvalidIcon { .. }));
    }

    #[test]
    fn labels_are_short_plain_text_keyed_by_locale() {
        let long = "x".repeat(LABEL_MAX + 1);
        for bad in [
            r#""""#.to_string(),
            r#""   ""#.to_string(),
            format!("\"{long}\""),
            r#""line\nbreak""#.to_string(),
            r#"{}"#.to_string(),
            r#"{"__proto__":"x"}"#.to_string(),
            r#"{"EN":"x"}"#.to_string(),
            r#"{"english":"x"}"#.to_string(),
            r#"{"zh-tw":"x"}"#.to_string(),
            r#"{"default":""}"#.to_string(),
        ] {
            let json = format!(r#"{{"sections":{{"projects":{{"label":{bad}}}}}}}"#);
            let err = check(&json).unwrap_err();
            assert!(matches!(err, SidebarValidationError::InvalidValue { .. }), "{bad}: {err}");
        }
        assert!(check(&format!(r#"{{"menu":{{"settings":{{"label":"{}"}}}}}}"#, "字".repeat(LABEL_MAX))).is_ok(), "40 characters, not 40 bytes");
    }

    #[test]
    fn brand_height_is_bounded() {
        for bad in ["11", "41", "-1", "1e9"] {
            let json = format!(r#"{{"brand":{{"height":{bad}}}}}"#);
            assert!(matches!(check(&json).unwrap_err(), SidebarValidationError::InvalidValue { .. }), "{bad}");
        }
        assert!(check(r#"{"brand":{"height":12}}"#).is_ok());
        assert!(check(r#"{"brand":{"height":40}}"#).is_ok());
    }

    #[test]
    fn asset_path_and_locale_shapes() {
        for ok in ["assets/a.svg", "assets/nav/chat-on.PNG", "assets/x_y/z.jpeg"] {
            assert!(is_asset_image_path(ok), "{ok}");
        }
        for ok in ["default", "en", "zh-TW"] {
            assert!(is_locale_key(ok), "{ok}");
        }
    }
}
