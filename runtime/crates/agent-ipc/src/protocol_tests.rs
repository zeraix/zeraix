//! `tests` for `protocol.rs`, kept out of the source file (declared there as `mod tests`).

use super::*;

#[test]
fn same_version_is_compatible() {
    assert!(is_compatible(PROTOCOL_VERSION));
}

#[test]
fn older_minor_is_accepted_newer_is_not() {
    assert!(is_compatible("1.0"));
    assert!(!is_compatible("1.9"), "host must not demand methods this build lacks");
}

/// The 1.0 host in the field must keep negotiating against a 1.1 runtime, or a packaged app whose
/// binary is newer than its bridge would lose the Stage 1 tools it already had.
#[test]
fn the_baseline_host_still_negotiates() {
    assert!(is_compatible("1.0"), "1.1 is additive; a 1.0 host loses nothing");
}

/// Why `features` exists: the version cannot distinguish "1.0 host, 1.1 runtime" (process.run is
/// there) from "1.1 host, 1.0 runtime" (it is not, and the handshake refuses). A host that routes
/// on the version alone gets the second case wrong.
#[test]
fn features_are_advertised_for_routing() {
    assert!(FEATURES.contains(&"process.run"));
}

#[test]
fn major_mismatch_is_refused() {
    assert!(!is_compatible("2.0"));
    assert!(!is_compatible("0.9"));
}

#[test]
fn garbage_is_refused_rather_than_assumed() {
    assert!(!is_compatible(""));
    assert!(!is_compatible("v1"));
    assert!(!is_compatible("1"));
}

#[test]
fn notification_has_no_id() {
    let r: Request = serde_json::from_str(r#"{"method":"tool.cancel","params":{}}"#).unwrap();
    assert!(r.is_notification());
    let r: Request = serde_json::from_str(r#"{"id":1,"method":"tool.list"}"#).unwrap();
    assert!(!r.is_notification());
}
