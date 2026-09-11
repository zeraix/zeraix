fn main() {
    // Only the addon build needs the Node-API link arguments (macOS's `-undefined dynamic_lookup`,
    // Windows' delay-load of the host). A plain `cargo test` has no Node host and must not get them.
    if std::env::var_os("CARGO_FEATURE_NODE").is_some() {
        napi_build::setup();
    }
}
