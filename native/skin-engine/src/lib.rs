//! skin-engine: filesystem, archive and validation work for skin packages (`.skinpkg`).
//!
//! Module map, in the order a package meets them:
//!
//! - [`manifest`]: `manifest.json` schema and validation (Stage 1).
//! - [`css`]: what a package's stylesheets may reference (a defence the prompt set leaves implicit:
//!   a stylesheet that can `@import` or `url()` a remote host is a tracking beacon).
//! - [`layout`]: `layout.json` / `components.json` — depth, node count, refs, props, cycle detection
//!   and expansion counting (Stage 7).
//! - [`extract`]: the install pipeline — every entry validated, then extracted to a temp directory
//!   that is renamed into place only once everything succeeded (Stage 2, with 7 wired in).
//! - [`sidebar`]: `sidebar.json` — brand images, nav order / labels / icons, sections, controls and
//!   the account menu, checked against the app's ids, its icon set and the files in the package.
//! - [`store`]: listing installed packages and the active-skin state file (Stage 3).
//! - `bindings` (feature `node`): the Node-API surface, returning structured results rather than
//!   throwing, so an error's code and detail survive the trip to the UI intact (Stage 4).
//!
//! Nothing here knows about React or the DOM.

pub mod css;
pub mod extract;
pub mod layout;
pub mod manifest;
pub mod sidebar;
pub mod store;

#[cfg(feature = "node")]
mod bindings;

/// The skin every install falls back to: the app's own palette, with no package directory behind it.
pub const DEFAULT_SKIN_ID: &str = "default";

/// Ids a package may not claim. `default` is the fallback, `current` is the `skin://current/` alias
/// and the rest would shadow theme modes or read as "no skin" in a settings file.
pub const RESERVED_SKIN_IDS: &[&str] = &["default", "current", "none", "light", "dark", "system"];

/// Renderer-defined presets carry this prefix; they have no directory and a package may not pose as one.
pub const BUILTIN_ID_PREFIX: &str = "builtin-";

/// Whether an id names a skin that exists without a package directory (the default or a preset).
pub fn is_builtin_id(id: &str) -> bool {
    id == DEFAULT_SKIN_ID || id.starts_with(BUILTIN_ID_PREFIX)
}

/// Whether a package may NOT use this id.
pub fn is_reserved_id(id: &str) -> bool {
    RESERVED_SKIN_IDS.contains(&id) || id.starts_with(BUILTIN_ID_PREFIX)
}

/// Bridge check: proves the addon loaded and the Rust side answers.
pub fn ping() -> String {
    format!("skin-engine {} ok", env!("CARGO_PKG_VERSION"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_names_the_crate_version() {
        assert_eq!(ping(), format!("skin-engine {} ok", env!("CARGO_PKG_VERSION")));
    }

    #[test]
    fn reserved_ids() {
        for id in RESERVED_SKIN_IDS {
            assert!(is_reserved_id(id), "{id} should be reserved");
        }
        assert!(is_reserved_id("builtin-midnight"));
        assert!(!is_reserved_id("aurora"));
        assert!(is_builtin_id("default"));
        assert!(is_builtin_id("builtin-ocean"));
        assert!(!is_builtin_id("current"));
    }
}
