//! The Node-API surface (feature `node`).
//!
//! Two rules keep the bridge honest, and the prompt set calls out the failure they prevent — a
//! `Result::Err` in Rust arriving in Node as a vague "Error occurred":
//!
//! 1. Nothing here throws for a *domain* outcome. A rejected package, a missing skin, a bad id all
//!    come back as `{ ok: false, error: { code, message, detail } }`, with `code` the stable key the
//!    UI translates and `detail` the specific file or value. A thrown error is reserved for the
//!    bridge itself being broken.
//! 2. Every filesystem call runs as an [`AsyncTask`] on libuv's thread pool, so the main process's
//!    event loop never blocks on a 50 MB archive.
//!
//! Field names cross as camelCase (`minAppVersion`): napi-rs renames struct fields on its own.

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::extract::{InstallOptions, SkinInstallError, inspect_skin_package, install_skin_package};
use crate::sidebar::SidebarRegistry;
use crate::layout::{RefAllowList, validate_package_layout};
use crate::manifest::{SkinManifest, validate_manifest_report};
use crate::store::{SkinStore, SkinStoreError, write_atomic, write_atomic_bytes};

#[napi]
pub fn ping() -> String {
    crate::ping()
}

#[napi]
pub fn default_skin_id() -> String {
    crate::DEFAULT_SKIN_ID.to_string()
}

/* --------------------------------------------------------------- results */

#[napi(object)]
#[derive(Debug, Clone)]
pub struct EngineError {
    pub code: String,
    pub message: String,
    pub detail: Option<String>,
}

impl From<&SkinInstallError> for EngineError {
    fn from(e: &SkinInstallError) -> Self {
        Self { code: e.code().to_string(), message: e.to_string(), detail: e.detail() }
    }
}

impl From<&SkinStoreError> for EngineError {
    fn from(e: &SkinStoreError) -> Self {
        Self { code: e.code().to_string(), message: e.to_string(), detail: e.detail() }
    }
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct ValidationResult {
    pub valid: bool,
    pub manifest: Option<SkinManifest>,
    pub errors: Option<Vec<String>>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct InstallResult {
    pub ok: bool,
    pub skin: Option<SkinManifest>,
    pub dir: Option<String>,
    pub files: Option<Vec<String>>,
    pub regions: Option<Vec<String>>,
    pub has_sidebar: Option<bool>,
    pub error: Option<EngineError>,
}

/// Everything the app renders that a package may name: layout refs, and the sidebar's nav items,
/// sections, controls, menu entries and icon names. Built by electron/skins/layoutRefs.mjs
/// (APP_REGISTRY). A missing list means "nothing of that kind exists".
#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct AppRegistry {
    pub refs: Option<Vec<String>>,
    pub nav_items: Option<Vec<String>>,
    pub sections: Option<Vec<String>>,
    pub controls: Option<Vec<String>>,
    pub menu: Option<Vec<String>>,
    pub icons: Option<Vec<String>>,
}

impl AppRegistry {
    fn into_options(self, app_version: Option<String>) -> InstallOptions {
        InstallOptions {
            allowed_refs: self.refs.unwrap_or_default(),
            app_version,
            sidebar: SidebarRegistry {
                nav_items: self.nav_items.unwrap_or_default(),
                sections: self.sections.unwrap_or_default(),
                controls: self.controls.unwrap_or_default(),
                menu: self.menu.unwrap_or_default(),
                icons: self.icons.unwrap_or_default(),
            },
        }
    }
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct StoreResult {
    pub ok: bool,
    pub error: Option<EngineError>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct LayoutCheck {
    pub ok: bool,
    pub regions: Option<Vec<String>>,
    pub error: Option<EngineError>,
}

// `std::result` spelled out: the napi prelude's `Result` alias means `napi::Error<E>`, not `E`.
fn store_result(r: std::result::Result<(), SkinStoreError>) -> StoreResult {
    match r {
        Ok(()) => StoreResult { ok: true, error: None },
        Err(e) => StoreResult { ok: false, error: Some((&e).into()) },
    }
}

/* ---------------------------------------------------------- synchronous */

/// Stage 1: `validateSkinManifest(jsonStr)` — every problem, or the manifest.
#[napi]
pub fn validate_skin_manifest(json_str: String) -> ValidationResult {
    match validate_manifest_report(&json_str) {
        Ok(m) => ValidationResult { valid: true, manifest: Some(m), errors: None },
        Err(errs) => ValidationResult { valid: false, manifest: None, errors: Some(errs.iter().map(|e| e.to_string()).collect()) },
    }
}

/// Stage 7/8: check a layout.json (and optional components.json) as the installer would. Lets the
/// settings UI validate an export before the author zips it.
#[napi]
pub fn validate_layout_json(layout: Option<String>, components: Option<String>, allowed_refs: Vec<String>) -> LayoutCheck {
    let allow = RefAllowList::new(allowed_refs);
    match validate_package_layout(layout.as_deref(), components.as_deref(), &allow) {
        Ok((tree, _)) => LayoutCheck { ok: true, regions: Some(tree.map(|t| t.regions.keys().cloned().collect()).unwrap_or_default()), error: None },
        Err(e) => LayoutCheck {
            ok: false,
            regions: None,
            error: Some(EngineError { code: e.code().to_string(), message: e.to_string(), detail: Some(e.to_string()) }),
        },
    }
}

/* ---------------------------------------------------------------- tasks */

pub struct InstallTask {
    source_path: String,
    skins_dir: String,
    opts: InstallOptions,
    inspect_only: bool,
}

impl Task for InstallTask {
    type Output = InstallResult;
    type JsValue = InstallResult;

    fn compute(&mut self) -> Result<Self::Output> {
        let failed = |e: &SkinInstallError| InstallResult { ok: false, skin: None, dir: None, files: None, regions: None, has_sidebar: None, error: Some(e.into()) };
        if self.inspect_only {
            return Ok(match inspect_skin_package(&self.source_path, &self.opts) {
                Ok(m) => InstallResult { ok: true, skin: Some(m), dir: None, files: None, regions: None, has_sidebar: None, error: None },
                Err(e) => failed(&e),
            });
        }
        Ok(match install_skin_package(&self.source_path, &self.skins_dir, &self.opts) {
            Ok(x) => InstallResult {
                ok: true,
                skin: Some(x.manifest),
                dir: Some(x.dir.to_string_lossy().into_owned()),
                files: Some(x.files),
                regions: Some(x.regions),
                has_sidebar: Some(x.has_sidebar),
                error: None,
            },
            Err(e) => failed(&e),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Stage 2: `installSkinPackage(sourcePath, skinsDir, registry, appVersion?)`.
#[napi(ts_return_type = "Promise<InstallResult>")]
pub fn install_skin_package_async(source_path: String, skins_dir: String, registry: AppRegistry, app_version: Option<String>) -> AsyncTask<InstallTask> {
    AsyncTask::new(InstallTask { source_path, skins_dir, opts: registry.into_options(app_version), inspect_only: false })
}

/// Validate without installing: the same checks, nothing written.
#[napi(ts_return_type = "Promise<InstallResult>")]
pub fn inspect_skin_package_async(source_path: String, registry: AppRegistry, app_version: Option<String>) -> AsyncTask<InstallTask> {
    AsyncTask::new(InstallTask { source_path, skins_dir: String::new(), opts: registry.into_options(app_version), inspect_only: true })
}

pub struct ListTask {
    skins_dir: String,
}

impl Task for ListTask {
    type Output = Vec<SkinManifest>;
    type JsValue = Vec<SkinManifest>;
    fn compute(&mut self) -> Result<Self::Output> {
        Ok(SkinStore::list_skins(&self.skins_dir))
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(ts_return_type = "Promise<Array<SkinManifest>>")]
pub fn list_skins(skins_dir: String) -> AsyncTask<ListTask> {
    AsyncTask::new(ListTask { skins_dir })
}

/// First paint needs the active id before the window draws; the state file is a few bytes.
#[napi]
pub fn get_active_skin_sync(state_path: String) -> Option<String> {
    SkinStore::get_active_skin(&state_path)
}

pub struct GetActiveTask {
    state_path: String,
}

impl Task for GetActiveTask {
    type Output = Option<String>;
    type JsValue = Option<String>;
    fn compute(&mut self) -> Result<Self::Output> {
        Ok(SkinStore::get_active_skin(&self.state_path))
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(ts_return_type = "Promise<string | null>")]
pub fn get_active_skin(state_path: String) -> AsyncTask<GetActiveTask> {
    AsyncTask::new(GetActiveTask { state_path })
}

pub struct SetActiveTask {
    state_path: String,
    skins_dir: String,
    skin_id: String,
}

impl Task for SetActiveTask {
    type Output = StoreResult;
    type JsValue = StoreResult;
    fn compute(&mut self) -> Result<Self::Output> {
        Ok(store_result(SkinStore::set_active_skin(&self.state_path, &self.skins_dir, &self.skin_id)))
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(ts_return_type = "Promise<StoreResult>")]
pub fn set_active_skin(state_path: String, skins_dir: String, skin_id: String) -> AsyncTask<SetActiveTask> {
    AsyncTask::new(SetActiveTask { state_path, skins_dir, skin_id })
}

pub struct DeleteTask {
    skins_dir: String,
    state_path: String,
    skin_id: String,
}

impl Task for DeleteTask {
    type Output = StoreResult;
    type JsValue = StoreResult;
    fn compute(&mut self) -> Result<Self::Output> {
        Ok(store_result(SkinStore::delete_skin(&self.skins_dir, &self.state_path, &self.skin_id)))
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

#[napi(ts_return_type = "Promise<StoreResult>")]
pub fn delete_skin(skins_dir: String, state_path: String, skin_id: String) -> AsyncTask<DeleteTask> {
    AsyncTask::new(DeleteTask { skins_dir, state_path, skin_id })
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct TextResult {
    pub ok: bool,
    /// The file's text; null when the package has no such file.
    pub text: Option<String>,
    pub error: Option<EngineError>,
}

pub struct ReadTextTask {
    skins_dir: String,
    skin_id: String,
    rel_path: String,
}

impl Task for ReadTextTask {
    type Output = TextResult;
    type JsValue = TextResult;
    fn compute(&mut self) -> Result<Self::Output> {
        Ok(match SkinStore::read_text(&self.skins_dir, &self.skin_id, &self.rel_path) {
            Ok(text) => TextResult { ok: true, text, error: None },
            Err(e) => TextResult { ok: false, text: None, error: Some((&e).into()) },
        })
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// `readSkinText(skinsDir, skinId, relPath)`: layout.json / components.json / tokens.css of an
/// installed package for the renderer, which cannot `fetch()` them from `skin://` (see store.rs).
#[napi(ts_return_type = "Promise<TextResult>")]
pub fn read_skin_text(skins_dir: String, skin_id: String, rel_path: String) -> AsyncTask<ReadTextTask> {
    AsyncTask::new(ReadTextTask { skins_dir, skin_id, rel_path })
}

pub struct WriteTextTask {
    path: String,
    text: String,
}

impl Task for WriteTextTask {
    type Output = StoreResult;
    type JsValue = StoreResult;
    fn compute(&mut self) -> Result<Self::Output> {
        Ok(store_result(write_atomic(std::path::Path::new(&self.path), &self.text)))
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Stage 8's layout export: the renderer builds the JSON, the main process picks the file with a
/// save dialog, and the write itself still happens here so the filesystem stays on this side.
#[napi(ts_return_type = "Promise<StoreResult>")]
pub fn write_text_file(path: String, text: String) -> AsyncTask<WriteTextTask> {
    AsyncTask::new(WriteTextTask { path, text })
}

pub struct WriteBytesTask {
    path: String,
    bytes: Vec<u8>,
}

impl Task for WriteBytesTask {
    type Output = StoreResult;
    type JsValue = StoreResult;
    fn compute(&mut self) -> Result<Self::Output> {
        Ok(store_result(write_atomic_bytes(std::path::Path::new(&self.path), &self.bytes)))
    }
    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// `writeFileBytes(path, buffer)`: the settings page's "Download package template" -- a zip the main
/// process builds from electron/skins/package-template, written here like every other file.
#[napi(ts_return_type = "Promise<StoreResult>")]
pub fn write_file_bytes(path: String, data: Buffer) -> AsyncTask<WriteBytesTask> {
    AsyncTask::new(WriteBytesTask { path, bytes: Vec::from(data) })
}
