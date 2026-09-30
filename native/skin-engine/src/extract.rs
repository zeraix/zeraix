//! Installing a `.skinpkg`: validate everything, then write, then swap into place.
//!
//! The order is the design. Every entry of the archive is checked from its central-directory
//! metadata — path, extension, declared size, running total — and the text files that carry
//! rules (manifest.json, tokens.css, layout.json, components.json, every other .css and .svg) are
//! read into memory and validated, all before a directory is created. Only a package that has
//! passed every check is extracted, into `<final>.tmp`, and only a fully extracted temp directory
//! is renamed to `<final>`. A rejected package therefore leaves nothing behind, and a crash during
//! extraction leaves at most a `.tmp` directory that the next install of the same id removes.
//!
//! The declared sizes are not trusted on their own: a header can claim 1 KB for an entry that
//! inflates to a gigabyte. Each entry is copied through a reader capped at its declared size, and
//! an entry that produces more (or fewer) bytes than declared fails the install.

use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use thiserror::Error;
use zip::ZipArchive;
use zip::read::ZipFile;

use crate::css::{CssViolation, check_stylesheet, check_svg};
use crate::layout::{LayoutValidationError, RefAllowList, validate_package_layout};
use crate::sidebar::{SidebarRegistry, SidebarValidationError, validate_sidebar};
use crate::manifest::{SkinManifest, SkinValidationError, is_compatible, is_safe_relative_path, validate_manifest};
use crate::is_reserved_id;

pub const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 50 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 2000;
/// Text files are held in memory for validation; a rules file this large is not a rules file.
pub const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
pub const ALLOWED_EXTENSIONS: &[&str] = &["json", "css", "png", "jpg", "jpeg", "webp", "gif", "svg", "woff2"];

pub const MANIFEST_FILE: &str = "manifest.json";
pub const TOKENS_FILE: &str = "tokens.css";
pub const LAYOUT_FILE: &str = "layout.json";
pub const COMPONENTS_FILE: &str = "components.json";
pub const SIDEBAR_FILE: &str = "sidebar.json";
pub const TMP_SUFFIX: &str = ".tmp";

#[derive(Debug, Error)]
pub enum SkinInstallError {
    #[error("the package could not be opened: {0}")]
    Unreadable(String),
    #[error("the package is not a valid skin archive: {0}")]
    CorruptArchive(String),
    #[error("the package contains a path that escapes the install directory: {0}")]
    PathTraversal(String),
    #[error("disallowed file type: {0}")]
    DisallowedFileType(String),
    #[error("size limit exceeded: {0}")]
    SizeLimit(String),
    #[error("the package has {count} entries; the limit is {max}")]
    TooManyEntries { count: usize, max: usize },
    #[error("manifest.json is missing from the package root")]
    MissingManifest,
    #[error("tokens.css is missing from the package root")]
    MissingTokens,
    #[error(transparent)]
    InvalidManifest(#[from] SkinValidationError),
    #[error("stylesheet {file}: {violation}")]
    InvalidStylesheet { file: String, violation: CssViolation },
    #[error("image {file}: {violation}")]
    InvalidSvg { file: String, violation: CssViolation },
    #[error(transparent)]
    InvalidLayout(#[from] LayoutValidationError),
    #[error(transparent)]
    InvalidSidebar(#[from] SidebarValidationError),
    #[error("the skin id \"{0}\" is reserved")]
    ReservedId(String),
    #[error("this skin needs app version {range}; this app is {app}")]
    Incompatible { range: String, app: String },
    #[error("could not write to disk: {0}")]
    DiskWrite(String),
}

impl SkinInstallError {
    /// Stable identifier the UI translates (`skinpkg.error.<code>`).
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unreadable(_) => "packageUnreadable",
            Self::CorruptArchive(_) => "packageCorrupt",
            Self::PathTraversal(_) => "pathTraversal",
            Self::DisallowedFileType(_) => "disallowedFileType",
            Self::SizeLimit(_) => "sizeLimit",
            Self::TooManyEntries { .. } => "tooManyEntries",
            Self::MissingManifest => "missingManifest",
            Self::MissingTokens => "missingTokens",
            Self::InvalidManifest(e) => e.code(),
            Self::InvalidStylesheet { .. } => "invalidStylesheet",
            Self::InvalidSvg { .. } => "invalidSvg",
            Self::InvalidLayout(e) => e.code(),
            Self::InvalidSidebar(e) => e.code(),
            Self::ReservedId(_) => "reservedId",
            Self::Incompatible { .. } => "incompatible",
            Self::DiskWrite(_) => "diskWrite",
        }
    }

    /// The specific thing that was wrong — a file name, an id, a snippet — shown beside the
    /// translated message so "disallowed file type" arrives as "disallowed file type: tools/run.exe".
    pub fn detail(&self) -> Option<String> {
        match self {
            Self::Unreadable(d) | Self::CorruptArchive(d) | Self::PathTraversal(d) | Self::DisallowedFileType(d) | Self::SizeLimit(d) | Self::DiskWrite(d) => Some(d.clone()),
            Self::TooManyEntries { count, max } => Some(format!("{count} > {max}")),
            Self::MissingManifest | Self::MissingTokens => None,
            Self::InvalidManifest(e) => Some(e.detail()),
            Self::InvalidStylesheet { file, violation } | Self::InvalidSvg { file, violation } => Some(format!("{file}: {violation}")),
            Self::InvalidLayout(e) => Some(e.to_string()),
            Self::InvalidSidebar(e) => Some(e.to_string()),
            Self::ReservedId(id) => Some(id.clone()),
            Self::Incompatible { range, app } => Some(format!("needs {range}, app is {app}")),
        }
    }
}

impl From<io::Error> for SkinInstallError {
    fn from(e: io::Error) -> Self {
        Self::DiskWrite(e.to_string())
    }
}

/// What the app tells the engine about itself for one install.
#[derive(Debug, Clone, Default)]
pub struct InstallOptions {
    /// Every `app:` and `primitive:` ref the renderer registers. Empty means a layout may use none.
    pub allowed_refs: Vec<String>,
    /// The running app's semver, checked against `min_app_version` / `max_app_version`.
    pub app_version: Option<String>,
    /// The nav items, sections, controls, menu entries and icon names a sidebar.json may name.
    pub sidebar: SidebarRegistry,
}

#[derive(Debug, Clone)]
pub struct ExtractedSkin {
    pub manifest: SkinManifest,
    pub dir: PathBuf,
    pub files: Vec<String>,
    pub total_bytes: u64,
    pub has_layout: bool,
    pub has_components: bool,
    /// Region names layout.json defines, so the app can tell which slots the skin fills.
    pub regions: Vec<String>,
    pub has_sidebar: bool,
}

type IResult<T> = Result<T, SkinInstallError>;

fn extension_of(name: &str) -> Option<String> {
    let base = name.rsplit('/').next()?;
    let (stem, ext) = base.rsplit_once('.')?;
    if stem.is_empty() || ext.is_empty() {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

/// The normalised, package-relative path of an entry, or the reason it is refused.
fn entry_path(raw: &str, is_dir: bool) -> IResult<String> {
    let trimmed = if is_dir { raw.trim_end_matches('/') } else { raw };
    if trimmed.is_empty() {
        return Err(SkinInstallError::PathTraversal(raw.to_string()));
    }
    // The exact patterns the prompt set names, checked by name so the error says which one.
    if raw.contains("..") || raw.starts_with('/') || raw.starts_with('\\') || raw.contains('\\') || raw.contains('\0') || raw.as_bytes().get(1) == Some(&b':') {
        return Err(SkinInstallError::PathTraversal(raw.to_string()));
    }
    if !is_safe_relative_path(trimmed) {
        return Err(SkinInstallError::PathTraversal(raw.to_string()));
    }
    Ok(trimmed.to_string())
}

fn is_symlink(file: &ZipFile<'_, File>) -> bool {
    file.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
}

/// Files zip tools add on their own: macOS Finder's `__MACOSX/` tree and `._*` AppleDouble files,
/// `.DS_Store`, and Windows' `Thumbs.db` / `desktop.ini`. They are skipped -- never read, never
/// written -- instead of failing an install over a file the author never put there (Finder's
/// "Compress" adds them to every zip). Everything else keeps the hard rule: one disallowed file
/// rejects the whole package.
pub fn is_os_metadata(path: &str) -> bool {
    let base = path.rsplit('/').next().unwrap_or(path);
    path == "__MACOSX"
        || path.starts_with("__MACOSX/")
        || base == ".DS_Store"
        || base.starts_with("._")
        || base.eq_ignore_ascii_case("thumbs.db")
        || base.eq_ignore_ascii_case("desktop.ini")
}

struct Scanned {
    /// (index in the archive, package-relative path, declared size)
    files: Vec<(usize, String, u64)>,
    total: u64,
}

/// Pass 1: metadata only. Nothing is decompressed here.
fn scan(archive: &mut ZipArchive<File>) -> IResult<Scanned> {
    let count = archive.len();
    if count > MAX_ENTRIES {
        return Err(SkinInstallError::TooManyEntries { count, max: MAX_ENTRIES });
    }
    let mut files = Vec::with_capacity(count);
    let mut seen = std::collections::HashSet::new();
    let mut total: u64 = 0;
    for i in 0..count {
        let file = archive.by_index_raw(i).map_err(|e| SkinInstallError::CorruptArchive(e.to_string()))?;
        let raw = file.name().to_string();
        let is_dir = file.is_dir();
        let path = entry_path(&raw, is_dir)?;
        // After the path check, so a metadata-looking name cannot carry a traversal past it.
        if is_dir || is_os_metadata(&path) {
            continue;
        }
        if is_symlink(&file) {
            return Err(SkinInstallError::DisallowedFileType(format!("{path} (symbolic link)")));
        }
        match extension_of(&path) {
            Some(ext) if ALLOWED_EXTENSIONS.contains(&ext.as_str()) => {}
            Some(ext) => return Err(SkinInstallError::DisallowedFileType(format!("{path} (.{ext})"))),
            None => return Err(SkinInstallError::DisallowedFileType(format!("{path} (no extension)"))),
        }
        let size = file.size();
        if size > MAX_FILE_BYTES {
            return Err(SkinInstallError::SizeLimit(format!("{path} is {} bytes; the limit per file is {} bytes", size, MAX_FILE_BYTES)));
        }
        total = total.saturating_add(size);
        if total > MAX_TOTAL_BYTES {
            return Err(SkinInstallError::SizeLimit(format!("the package inflates to more than {} bytes", MAX_TOTAL_BYTES)));
        }
        // Two entries that differ only by case would fight over one file on Windows and macOS.
        if !seen.insert(path.to_ascii_lowercase()) {
            return Err(SkinInstallError::CorruptArchive(format!("duplicate entry {path}")));
        }
        files.push((i, path, size));
    }
    Ok(Scanned { files, total })
}

/// Decompress one entry into memory, refusing more bytes than declared.
fn read_entry(archive: &mut ZipArchive<File>, index: usize, path: &str, declared: u64) -> IResult<Vec<u8>> {
    if declared > MAX_TEXT_BYTES {
        return Err(SkinInstallError::SizeLimit(format!("{path} is too large for a text file")));
    }
    let file = archive.by_index(index).map_err(|e| SkinInstallError::CorruptArchive(e.to_string()))?;
    let mut buf = Vec::with_capacity(declared as usize);
    file.take(declared + 1).read_to_end(&mut buf).map_err(|e| SkinInstallError::CorruptArchive(format!("{path}: {e}")))?;
    if buf.len() as u64 != declared {
        return Err(SkinInstallError::SizeLimit(format!("{path} does not match its declared size")));
    }
    Ok(buf)
}

fn read_text(archive: &mut ZipArchive<File>, index: usize, path: &str, declared: u64) -> IResult<String> {
    let bytes = read_entry(archive, index, path, declared)?;
    let text = String::from_utf8(bytes).map_err(|_| SkinInstallError::CorruptArchive(format!("{path} is not UTF-8")))?;
    Ok(text.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(text))
}

struct Validated {
    manifest: SkinManifest,
    scanned: Scanned,
    has_layout: bool,
    has_components: bool,
    regions: Vec<String>,
    has_sidebar: bool,
}

/// Everything that can be decided without writing: the whole check, in the order the errors
/// should be reported (structure of the archive, then the manifest, then each rules file).
fn validate(archive: &mut ZipArchive<File>, opts: &InstallOptions) -> IResult<Validated> {
    let scanned = scan(archive)?;
    let find = |name: &str| scanned.files.iter().find(|(_, p, _)| p == name).map(|(i, p, s)| (*i, p.clone(), *s));

    let Some((mi, mp, ms)) = find(MANIFEST_FILE) else { return Err(SkinInstallError::MissingManifest) };
    let manifest = validate_manifest(&read_text(archive, mi, &mp, ms)?)?;
    if is_reserved_id(&manifest.id) {
        return Err(SkinInstallError::ReservedId(manifest.id.clone()));
    }
    if let Some(app) = &opts.app_version {
        if !is_compatible(&manifest, app) {
            let range = match (&manifest.min_app_version, &manifest.max_app_version) {
                (Some(a), Some(b)) => format!("{a} - {b}"),
                (Some(a), None) => format!(">= {a}"),
                (None, Some(b)) => format!("<= {b}"),
                (None, None) => "?".into(),
            };
            return Err(SkinInstallError::Incompatible { range, app: app.clone() });
        }
    }
    if find(TOKENS_FILE).is_none() {
        return Err(SkinInstallError::MissingTokens);
    }

    // Every stylesheet and every SVG, not only the ones the app links today.
    for (i, path, size) in &scanned.files {
        match extension_of(path).as_deref() {
            Some("css") => {
                let css = read_text(archive, *i, path, *size)?;
                check_stylesheet(&css).map_err(|violation| SkinInstallError::InvalidStylesheet { file: path.clone(), violation })?;
            }
            Some("svg") => {
                let svg = read_text(archive, *i, path, *size)?;
                check_svg(&svg).map_err(|violation| SkinInstallError::InvalidSvg { file: path.clone(), violation })?;
            }
            _ => {}
        }
    }

    let layout = match find(LAYOUT_FILE) {
        Some((i, p, s)) => Some(read_text(archive, i, &p, s)?),
        None => None,
    };
    let components = match find(COMPONENTS_FILE) {
        Some((i, p, s)) => Some(read_text(archive, i, &p, s)?),
        None => None,
    };
    let allow = RefAllowList::new(opts.allowed_refs.iter().cloned());
    let (tree, _map) = validate_package_layout(layout.as_deref(), components.as_deref(), &allow)?;
    let regions = tree.map(|t| t.regions.keys().cloned().collect()).unwrap_or_default();

    // sidebar.json last: its image paths are checked against the archive's own file list, so an icon
    // that names a file the package does not ship is refused here rather than drawn broken later.
    let has_sidebar = match find(SIDEBAR_FILE) {
        Some((i, p, s)) => {
            let text = read_text(archive, i, &p, s)?;
            let files: std::collections::HashSet<&str> = scanned.files.iter().map(|(_, path, _)| path.as_str()).collect();
            validate_sidebar(&text, &opts.sidebar, &|f: &str| files.contains(f))?;
            true
        }
        None => false,
    };

    Ok(Validated { manifest, has_layout: layout.is_some(), has_components: components.is_some(), regions, has_sidebar, scanned })
}

fn open(source_path: &str) -> IResult<ZipArchive<File>> {
    let meta = fs::symlink_metadata(source_path).map_err(|e| SkinInstallError::Unreadable(e.to_string()))?;
    if !meta.is_file() {
        return Err(SkinInstallError::Unreadable("not a regular file".into()));
    }
    let file = File::open(source_path).map_err(|e| SkinInstallError::Unreadable(e.to_string()))?;
    ZipArchive::new(file).map_err(|e| SkinInstallError::CorruptArchive(e.to_string()))
}

/// Validate a package without writing anything. What the settings UI can call to preview.
pub fn inspect_skin_package(source_path: &str, opts: &InstallOptions) -> IResult<SkinManifest> {
    let mut archive = open(source_path)?;
    Ok(validate(&mut archive, opts)?.manifest)
}

/// Pass 2: write every file into `tmp`, each through a size-capped reader.
fn write_all(archive: &mut ZipArchive<File>, scanned: &Scanned, tmp: &Path) -> IResult<Vec<String>> {
    let mut written = Vec::with_capacity(scanned.files.len());
    for (i, path, declared) in &scanned.files {
        let dest = tmp.join(path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = archive.by_index(*i).map_err(|e| SkinInstallError::CorruptArchive(e.to_string()))?;
        let mut out = File::create(&dest)?;
        let copied = io::copy(&mut file.take(declared + 1), &mut out).map_err(|e| SkinInstallError::CorruptArchive(format!("{path}: {e}")))?;
        if copied != *declared {
            return Err(SkinInstallError::SizeLimit(format!("{path} does not match its declared size")));
        }
        written.push(path.clone());
    }
    Ok(written)
}

fn nanos() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)
}

/// `tmp` becomes `dest`. An existing `dest` (a reinstall) is moved aside first and removed after,
/// and put back if the swap fails.
fn swap_in(tmp: &Path, dest: &Path) -> IResult<()> {
    if !dest.exists() {
        fs::rename(tmp, dest)?;
        return Ok(());
    }
    let name = dest.file_name().and_then(|n| n.to_str()).unwrap_or("skin");
    let old = dest.with_file_name(format!("{name}.old-{}", nanos()));
    fs::rename(dest, &old)?;
    if let Err(e) = fs::rename(tmp, dest) {
        let _ = fs::rename(&old, dest);
        return Err(e.into());
    }
    let _ = fs::remove_dir_all(&old);
    Ok(())
}

/// Extract a validated package into `dest_dir` (the package's final directory) via `dest_dir.tmp`.
pub fn extract_skin_package(source_path: &str, dest_dir: &str, opts: &InstallOptions) -> IResult<ExtractedSkin> {
    let mut archive = open(source_path)?;
    let validated = validate(&mut archive, opts)?;

    let dest = PathBuf::from(dest_dir);
    let Some(parent) = dest.parent() else { return Err(SkinInstallError::DiskWrite("destination has no parent directory".into())) };
    let name = dest.file_name().and_then(|n| n.to_str()).ok_or_else(|| SkinInstallError::DiskWrite("destination has no name".into()))?;
    let tmp = parent.join(format!("{name}{TMP_SUFFIX}"));

    fs::create_dir_all(parent)?;
    if tmp.exists() {
        fs::remove_dir_all(&tmp)?;
    }
    fs::create_dir(&tmp)?;

    let result = write_all(&mut archive, &validated.scanned, &tmp).and_then(|files| {
        swap_in(&tmp, &dest)?;
        Ok(files)
    });
    match result {
        Ok(files) => Ok(ExtractedSkin {
            manifest: validated.manifest,
            dir: dest,
            files,
            total_bytes: validated.scanned.total,
            has_layout: validated.has_layout,
            has_components: validated.has_components,
            regions: validated.regions,
            has_sidebar: validated.has_sidebar,
        }),
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp);
            Err(e)
        }
    }
}

/// Install into `<skins_dir>/<manifest.id>`. The id comes from the archive, so the archive is
/// validated first and the destination derived from what it says.
pub fn install_skin_package(source_path: &str, skins_dir: &str, opts: &InstallOptions) -> IResult<ExtractedSkin> {
    let manifest = inspect_skin_package(source_path, opts)?;
    let dest = Path::new(skins_dir).join(&manifest.id);
    let dest = dest.to_str().ok_or_else(|| SkinInstallError::DiskWrite("skins directory is not valid UTF-8".into()))?.to_string();
    extract_skin_package(source_path, &dest, opts)
}

#[cfg(test)]
#[path = "extract_tests.rs"]
mod tests;
