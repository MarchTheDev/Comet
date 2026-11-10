//! Scoped, per-file rclone sync. Immutable blobs and revision manifests are
//! published before a commit marker; no remote delete, mirror or bisync is
//! used. Legacy whole-workspace histories live in a different namespace.
//!
//! File contents are staged one at a time on disk (not in a workspace-sized
//! archive). Only explicitly supported UTF-8 text and Comet boards are sent.
use super::{auth::remote_ok, engine::{checked_folder, pause, Engine}, hash, new_id, ROOT};
use crate::google::{ancestor_distances, common_ancestor, group_id, heads, ConnectingGuard, Revision, SYNCING};
use crate::google::incremental::{hash_ok, validate_history, MANIFEST_LIMIT};
use crate::workspace_archive::{self, MergeSummary};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, atomic::Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

// Comet's text editor already has this per-file bound. There is deliberately
// no aggregate workspace-byte limit; media never enters a sync staging area.
const MAX_FILE: usize = 16 * 1024 * 1024;
const MAX_FILES: usize = 20_000;
static PREPARED: Mutex<Option<Job>> = Mutex::new(None);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileVersion { path: String, size: u64, hash: String, blob: String }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest { version: u8, group: String, entries: Vec<FileVersion> }
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredRevision { version: u8, id: String, group: String, name: String, parents: Vec<String>, manifest: Manifest }
struct Item { revision: Revision, manifest: Manifest }

fn object_id(id: &str) -> bool { id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn excluded_directory(name: &str) -> bool { matches!(name.to_ascii_lowercase().as_str(), ".git" | ".hg" | ".svn") }
fn eligible(path: &str) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    if parts.is_empty() || parts[..parts.len() - 1].iter().any(|part| excluded_directory(part)) { return false; }
    let name = parts[parts.len() - 1];
    let extension = name.rfind('.').filter(|index| *index > 0).map(|index| name[index + 1..].to_ascii_lowercase());
    match extension.as_deref() {
        None => true,
        Some(ext) => matches!(ext, "md" | "markdown" | "txt" | "text" | "log" | "csv" | "tsv" | "json" | "jsonl" | "xml" | "yaml" | "yml" | "toml" | "ini" | "cfg" | "conf" | "html" | "htm" | "css" | "js" | "jsx" | "ts" | "tsx" | "py" | "rs" | "sh" | "sql" | "tex" | "rst" | "comet-todo" | "comet-whiteboard"),
    }
}
fn text_content(bytes: &[u8]) -> bool { !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok() }
fn same(a: Option<&FileVersion>, b: Option<&FileVersion>) -> bool {
    match (a, b) { (None, None) => true, (Some(a), Some(b)) => a.size == b.size && a.hash == b.hash, _ => false }
}
fn add_case_path(names: &mut HashMap<String, String>, name: &str) -> Result<(), String> {
    let mut path = String::new();
    for part in name.split('/') {
        if !path.is_empty() { path.push('/'); } path.push_str(part);
        let folded = path.to_lowercase();
        if names.get(&folded).is_some_and(|existing| existing != &path) {
            return Err("Two sync paths differ only by letter case. Rename one before syncing across devices.".into());
        }
        names.insert(folded, path.clone());
    }
    Ok(())
}
fn validate_manifest(manifest: &Manifest, group: &str) -> Result<(), String> {
    if manifest.version != 2 || !group_id(group) || manifest.group != group || manifest.entries.len() > MAX_FILES {
        return Err("Invalid text sync manifest. No local files were changed.".into());
    }
    let mut paths = HashSet::new(); let mut cases = HashMap::new();
    for entry in &manifest.entries {
        if !workspace_archive::safe_path(&entry.path) || !eligible(&entry.path) || !paths.insert(entry.path.to_lowercase())
            || entry.size > MAX_FILE as u64 || !hash_ok(&entry.hash) || !object_id(&entry.blob) {
            return Err("The text sync manifest contains an excluded, unsafe or invalid file. No local files were changed.".into());
        }
        add_case_path(&mut cases, &entry.path)?;
    }
    for entry in &manifest.entries {
        let mut part = entry.path.as_str();
        while let Some((parent, _)) = part.rsplit_once('/') {
            if paths.contains(&parent.to_lowercase()) { return Err("A sync file conflicts with a parent folder. No local files were changed.".into()); }
            part = parent;
        }
    }
    Ok(())
}
fn validate_revision(item: &StoredRevision, id: &str, group: &str) -> Result<(), String> {
    if item.version != 2 || !object_id(id) || item.id != id || item.group != group || !group_id(group)
        || item.name.is_empty() || item.name.len() > 400 || item.name.chars().any(char::is_control)
        || item.parents.len() > 2 || item.parents.iter().any(|parent| !object_id(parent) || parent == id)
        || item.parents.iter().collect::<HashSet<_>>().len() != item.parents.len() {
        return Err("Invalid text sync revision. No local files were changed.".into());
    }
    validate_manifest(&item.manifest, group)
}
fn marker(name: &str) -> Option<(&str, &str)> {
    let (id, digest) = name.strip_suffix(".commit")?.split_once('-')?;
    (object_id(id) && hash_ok(digest)).then_some((id, digest))
}
/// Verified revision manifests are cached locally so a periodic check costs one
/// directory listing instead of re-downloading the whole history on every pass.
fn history_cache(engine: &Engine, group: &str) -> Option<PathBuf> {
    checked_folder(engine.cache_root(), "cloud-history").ok().and_then(|base| checked_folder(&base, group).ok())
}
async fn history(engine: &Engine, remote: &str, group: &str) -> Result<Vec<Item>, String> {
    if !remote_ok(remote) || !group_id(group) { return Err("Invalid cloud workspace.".into()); }
    let cache = history_cache(engine, group);
    let commits = format!("{ROOT}/{group}/commits");
    let revisions_dir = format!("{ROOT}/{group}/revisions");
    let mut result = Vec::new(); let mut ids = HashSet::new();
    for entry in engine.list(remote, &commits).await? {
        if entry.get("IsDir").and_then(serde_json::Value::as_bool) == Some(true) { continue; }
        let name = entry.get("Name").and_then(serde_json::Value::as_str).ok_or("Invalid cloud commit name.")?;
        if !name.ends_with(".commit") { continue; }
        let (id, expected) = marker(name).ok_or("Invalid cloud commit marker. No local files were changed.")?;
        if entry.get("Size").and_then(serde_json::Value::as_u64) != Some(0) || !ids.insert(id.to_string()) {
            return Err("Duplicate or damaged cloud commit markers. No local files were changed.".into());
        }
        let cached = cache.as_ref().and_then(|dir| fs::read(dir.join(format!("{id}.json"))).ok())
            .filter(|bytes| bytes.len() <= MANIFEST_LIMIT && hash(bytes) == expected)
            .and_then(|bytes| serde_json::from_slice::<StoredRevision>(&bytes).ok());
        let stored = if let Some(stored) = cached { stored } else {
            let bytes = engine.read(remote, &format!("{revisions_dir}/{id}.json"), MANIFEST_LIMIT).await?;
            if hash(&bytes) != expected { return Err("A cloud revision failed verification. No local files were changed.".into()); }
            if let Some(dir) = cache.as_ref() {
                let temp = dir.join(format!("{id}.tmp"));
                if fs::write(&temp, &bytes).is_ok() { let _ = fs::rename(&temp, dir.join(format!("{id}.json"))); }
            }
            serde_json::from_slice(&bytes).map_err(|_| "A cloud revision is damaged. No local files were changed.")?
        };
        validate_revision(&stored, id, group)?;
        let modified = entry.get("ModTime").and_then(serde_json::Value::as_str).unwrap_or("").chars().take(64).collect();
        result.push(Item { revision: Revision { id: id.into(), group: group.into(), name: stored.name, modified, parents: stored.parents }, manifest: stored.manifest });
    }
    // Recover revisions whose commit marker is missing: an interrupted upload
    // or a provider that has not listed the marker. The revision file is
    // self-validating and its blobs were verified before it was written, so it
    // can be adopted and its marker repaired instead of blocking every device.
    for entry in engine.list(remote, &revisions_dir).await.unwrap_or_default() {
        if entry.get("IsDir").and_then(serde_json::Value::as_bool) == Some(true) { continue; }
        let name = entry.get("Name").and_then(serde_json::Value::as_str).unwrap_or("");
        let Some(id) = name.strip_suffix(".json").filter(|id| object_id(id)) else { continue };
        if ids.contains(id) { continue; }
        let Ok(bytes) = engine.read(remote, &format!("{revisions_dir}/{name}"), MANIFEST_LIMIT).await else { continue };
        let Ok(stored) = serde_json::from_slice::<StoredRevision>(&bytes) else { continue };
        if validate_revision(&stored, id, group).is_err() { continue; }
        let digest = hash(&bytes);
        let _ = engine.upload(remote, &commits, &format!("{id}-{digest}.commit"), &[]).await;
        let modified = entry.get("ModTime").and_then(serde_json::Value::as_str).unwrap_or("").chars().take(64).collect();
        ids.insert(id.to_string());
        result.push(Item { revision: Revision { id: id.into(), group: group.into(), name: stored.name, modified, parents: stored.parents }, manifest: stored.manifest });
    }
    validate_history(&result.iter().map(|item| item.revision.clone()).collect::<Vec<_>>())?;
    Ok(result)
}

/// A random, private staging folder; removed on completion, abort and errors.
/// A crash may leave temporary plaintext files in the application's cache.
struct Stage { root: PathBuf }
impl Stage {
    fn new(cache: &Path) -> Result<Self, String> {
        let parent = checked_folder(cache, "comet-text-sync")?;
        let root = parent.join(new_id()?);
        fs::create_dir(&root).map_err(|_| "Couldn't create a cloud staging folder.")?;
        #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).map_err(|_| "Couldn't protect the cloud staging folder.")?; }
        Ok(Self { root })
    }
    fn write(&self, bytes: &[u8]) -> Result<PathBuf, String> {
        let path = self.root.join(new_id()?);
        let mut file = OpenOptions::new().write(true).create_new(true).open(&path).map_err(|_| "Couldn't stage a cloud file.")?;
        file.write_all(bytes).and_then(|_| file.sync_all()).map_err(|_| "Couldn't stage a complete cloud file.")?;
        Ok(path)
    }
}
impl Drop for Stage { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.root); } }
#[derive(Clone)]
struct LocalFile { version: FileVersion, staged: PathBuf }
struct Snapshot { files: BTreeMap<String, LocalFile>, cases: HashMap<String, String> }
fn workspace_root(vault: &str) -> Result<PathBuf, String> {
    let path = Path::new(vault);
    if !path.is_absolute() || path.components().any(|part| matches!(part, Component::ParentDir)) { return Err("Choose a local workspace folder.".into()); }
    let root = fs::canonicalize(path).map_err(|_| "Couldn't open the workspace for cloud sync.")?;
    if !root.is_dir() { return Err("The workspace isn't a folder.".into()); }
    Ok(root)
}
fn read_stable(path: &Path, observed: &fs::Metadata) -> Result<Vec<u8>, String> {
    if observed.len() > MAX_FILE as u64 { return Err(format!("{} exceeds the 16 MB per-text-file limit. Local files were preserved.", path.display())); }
    let file = File::open(path).map_err(|_| format!("Couldn't read {} for cloud sync.", path.display()))?;
    let before = file.metadata().map_err(|_| "Couldn't inspect a sync file.")?;
    if !before.is_file() || before.len() != observed.len() || before.modified().ok() != observed.modified().ok() { return Err("A file changed during sync; it will be retried.".into()); }
    let mut bytes = Vec::new(); (&file).take(MAX_FILE as u64 + 1).read_to_end(&mut bytes).map_err(|_| "Couldn't read a sync file.")?;
    let after = file.metadata().map_err(|_| "Couldn't inspect a sync file.")?;
    if bytes.len() as u64 != before.len() || after.len() != before.len() || after.modified().ok() != before.modified().ok() {
        return Err("A file changed during sync; it will be retried.".into());
    }
    if !text_content(&bytes) { return Err(format!("{} is not UTF-8 text. It was not uploaded; local files were preserved.", path.display())); }
    Ok(bytes)
}
fn snapshot(vault: &str, stage: &Stage) -> Result<Snapshot, String> {
    let root = workspace_root(vault)?;
    if stage.root.starts_with(&root) { return Err("Choose a workspace outside Comet's cloud cache folder.".into()); }
    let mut pending = vec![root.clone()]; let mut files = BTreeMap::new(); let mut cases = HashMap::new();
    while let Some(directory) = pending.pop() {
        let mut children = fs::read_dir(&directory).map_err(|_| "Couldn't read a workspace folder for sync.")?.collect::<Result<Vec<_>, _>>().map_err(|_| "Couldn't read a workspace item for sync.")?;
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            let path = child.path(); let name = child.file_name();
            if name.to_str().is_some_and(excluded_directory) && child.file_type().map_err(|_| "Couldn't inspect a workspace folder.")?.is_dir() { continue; }
            let meta = fs::symlink_metadata(&path).map_err(|_| "Couldn't inspect a workspace item.")?;
            if meta.file_type().is_symlink() { return Err("Cloud sync does not follow symbolic links. Remove the link before syncing; nothing was uploaded.".into()); }
            if !meta.is_dir() && !meta.is_file() { return Err("The workspace contains an unsupported item. No cloud changes were made.".into()); }
            if meta.is_dir() {
                let name = workspace_archive::relative_name(&root, &path)?;
                add_case_path(&mut cases, &name)?;
                if !fs::canonicalize(&path).map_err(|_| "Couldn't inspect a workspace folder.")?.starts_with(&root) { return Err("A sync folder points outside the workspace.".into()); }
                pending.push(path); continue;
            }
            // Determine scope before reading file content; media is never read.
            let raw = path.strip_prefix(&root).map_err(|_| "Invalid workspace path.")?.to_string_lossy().replace('\\', "/");
            if !eligible(&raw) { continue; }
            let relative = workspace_archive::relative_name(&root, &path)?;
            add_case_path(&mut cases, &relative)?;
            if files.len() >= MAX_FILES { return Err("This workspace has more than 20,000 text and board files. Local files were preserved.".into()); }
            let bytes = read_stable(&path, &meta)?; let digest = hash(&bytes); let staged = stage.write(&bytes)?;
            let version = FileVersion { path: relative.clone(), size: bytes.len() as u64, hash: digest, blob: String::new() };
            files.insert(relative, LocalFile { version, staged });
        }
    }
    Ok(Snapshot { files, cases })
}
fn snapshot_matches(snapshot: &Snapshot, manifest: &Manifest) -> bool {
    snapshot.files.len() == manifest.entries.len() && manifest.entries.iter().all(|entry| same(snapshot.files.get(&entry.path).map(|item| &item.version), Some(entry)))
}
fn staged_bytes(path: &Path, expected: &FileVersion) -> Result<Vec<u8>, String> {
    let meta = fs::symlink_metadata(path).map_err(|_| "A staged cloud file is missing.")?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() != expected.size || meta.len() > MAX_FILE as u64 { return Err("A staged cloud file is invalid.".into()); }
    let bytes = fs::read(path).map_err(|_| "Couldn't read a staged cloud file.")?;
    if bytes.len() as u64 != expected.size || hash(&bytes) != expected.hash || !text_content(&bytes) { return Err("A staged cloud file failed verification. No local files were changed by it.".into()); }
    Ok(bytes)
}
async fn download_changes(engine: &Engine, remote: &str, group: &str, old: Option<&Manifest>, incoming: &Manifest, stage: &Stage) -> Result<(HashMap<String, PathBuf>, usize), String> {
    validate_manifest(incoming, group)?;
    let old: HashMap<&str, &FileVersion> = old.into_iter().flat_map(|manifest| manifest.entries.iter()).map(|entry| (entry.path.as_str(), entry)).collect();
    let mut staged = HashMap::new(); let mut known: HashMap<(String, u64), PathBuf> = HashMap::new(); let mut count = 0;
    for entry in &incoming.entries {
        if same(old.get(entry.path.as_str()).copied(), Some(entry)) { continue; }
        let key = (entry.hash.clone(), entry.size);
        let path = if let Some(path) = known.get(&key) { path.clone() } else {
            let bytes = engine.read(remote, &format!("{ROOT}/{group}/blobs/{}", entry.blob), entry.size as usize + 1).await?;
            if bytes.len() as u64 != entry.size || hash(&bytes) != entry.hash || !text_content(&bytes) {
                return Err("A cloud file failed text or checksum verification. No local files were changed.".into());
            }
            let path = stage.write(&bytes)?; known.insert(key, path.clone()); count += 1; path
        };
        staged.insert(entry.path.clone(), path);
    }
    Ok((staged, count))
}
async fn build_manifest(engine: &Engine, remote: &str, group: &str, known_manifests: &[Manifest], snapshot: &Snapshot) -> Result<(Manifest, usize), String> {
    let mut known: HashMap<(String, u64), String> = HashMap::new();
    for manifest in known_manifests { for entry in &manifest.entries { known.entry((entry.hash.clone(), entry.size)).or_insert_with(|| entry.blob.clone()); } }
    let dir = format!("{ROOT}/{group}/blobs"); engine.mkdir(remote, &dir).await?;
    let mut entries = Vec::new(); let mut count = 0;
    for file in snapshot.files.values() {
        let key = (file.version.hash.clone(), file.version.size);
        let blob = if let Some(id) = known.get(&key) { id.clone() } else {
            let bytes = staged_bytes(&file.staged, &file.version)?; let id = new_id()?;
            engine.upload(remote, &dir, &id, &bytes).await?;
            let check = engine.read(remote, &format!("{dir}/{id}"), bytes.len() + 1).await?;
            if check != bytes { return Err("A cloud upload failed verification. Local files were preserved.".into()); }
            known.insert(key, id.clone()); count += 1; id
        };
        entries.push(FileVersion { blob, ..file.version.clone() });
    }
    let manifest = Manifest { version: 2, group: group.into(), entries };
    validate_manifest(&manifest, group)?; Ok((manifest, count))
}


// Browseable copies live beside the opaque history, e.g.
// Comet-Sync/My notes/Project/plan.md. They are updated in place so the folder
// is a usable mirror. Older dated layouts are never modified or deleted.
const SYNC_ROOT: &str = "Comet-Sync";
const MIRROR_INFO: &str = ".comet-sync-workspace.json";
const MIRROR_NOTE: &str = "Managed by Comet. Synced text is copied here for reading; edits made here are not synced back.";
fn readable_timestamp(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += if month <= 2 { 1 } else { 0 };
    let time = seconds % 86_400;
    format!("{year:04}-{month:02}-{day:02} {:02}-{:02}-{:02} UTC", time / 3600, (time % 3600) / 60, time % 60)
}
fn now_seconds() -> Result<u64, String> { SystemTime::now().duration_since(UNIX_EPOCH).map(|since| since.as_secs()).map_err(|_| "The system clock is unavailable.".into()) }
fn reserved_stem(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}
/// A readable folder name for one workspace. The opaque history lives in a
/// sibling folder, so this is the only folder a person needs to browse.
fn mirror_name(name: &str) -> String {
    let name = name.strip_prefix("Comet text sync - ").unwrap_or(name);
    let mut safe = String::new();
    for character in name.chars() {
        let character = if character.is_control() || matches!(character, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { character };
        if safe.len() + character.len_utf8() > 80 { break; }
        safe.push(character);
    }
    let safe = safe.trim().trim_end_matches('.').trim();
    let safe = if safe.is_empty() { "Workspace" } else { safe };
    if reserved_stem(safe) { format!("Workspace - {safe}") } else { safe.into() }
}
fn preserved_name(name: &str, stamp: &str) -> String {
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() && !extension.is_empty() && extension.len() <= 10 => (stem, format!(".{extension}")),
        _ => (name, String::new()),
    };
    let suffix = format!(" (Comet preserved {stamp}){extension}");
    let room = 200usize.saturating_sub(suffix.len());
    let mut short = String::new();
    for character in stem.chars() { if short.len() + character.len_utf8() > room { break; } short.push(character); }
    format!("{}{suffix}", short.trim_end())
}
async fn mirror_markers(engine: &Engine, remote: &str, group: &str) -> Result<HashSet<String>, String> {
    let dir = format!("{ROOT}/{group}/mirror");
    engine.mkdir(remote, &dir).await?;
    Ok(engine.list(remote, &dir).await?.iter().filter_map(|entry| {
        if entry.get("IsDir").and_then(serde_json::Value::as_bool) == Some(true) || entry.get("Size").and_then(serde_json::Value::as_u64) != Some(0) { return None; }
        entry.get("Name")?.as_str()?.strip_suffix(".done").filter(|stem| object_id(stem)).map(str::to_string)
    }).collect())
}
async fn write_mirror_info(engine: &Engine, remote: &str, folder: &str, group: &str) -> Result<(), String> {
    let data = serde_json::to_vec(&serde_json::json!({"version": 1, "group": group, "note": MIRROR_NOTE})).map_err(|_| "Couldn't prepare the cloud folder marker.")?;
    engine.upload(remote, folder, MIRROR_INFO, &data).await
}
/// Find (or claim) this workspace's readable folder. A folder owned by a
/// different workspace is never reused, so two workspaces with the same name
/// keep separate copies.
async fn mirror_folder(engine: &Engine, remote: &str, group: &str, name: &str) -> Result<String, String> {
    let base = format!("{SYNC_ROOT}/{}", mirror_name(name));
    engine.mkdir(remote, SYNC_ROOT).await?;
    let listing = engine.list(remote, SYNC_ROOT).await?;
    let has = |candidate: &str| listing.iter().any(|entry| entry.get("Name").and_then(serde_json::Value::as_str) == candidate.rsplit('/').next() && entry.get("IsDir").and_then(serde_json::Value::as_bool) == Some(true));
    for candidate in [base.clone(), format!("{base} ({})", group.get(..6).unwrap_or(group)), format!("{base} ({group})")] {
        if !has(&candidate) {
            engine.mkdir(remote, &candidate).await?;
            write_mirror_info(engine, remote, &candidate, group).await?;
            return Ok(candidate);
        }
        let files = engine.list(remote, &candidate).await?;
        let marker = files.iter().find(|entry| entry.get("Name").and_then(serde_json::Value::as_str) == Some(MIRROR_INFO));
        if let Some(marker) = marker {
            let data = engine.read(remote, &format!("{candidate}/{MIRROR_INFO}"), marker.get("Size").and_then(serde_json::Value::as_u64).unwrap_or(4096) as usize + 1).await?;
            let owner = serde_json::from_slice::<serde_json::Value>(&data).ok().and_then(|value| value.get("group").and_then(serde_json::Value::as_str).map(str::to_string));
            match owner {
                Some(owner) if owner == group => return Ok(candidate),
                Some(_) => continue,
                None => return Err("The readable cloud folder has an invalid ownership marker. Rename it in your cloud provider to let Comet use this name again.".into()),
            }
        }
        // An unmarked folder is adopted only when empty; otherwise it may hold
        // files this app did not write.
        if files.is_empty() { write_mirror_info(engine, remote, &candidate, group).await?; return Ok(candidate); }
    }
    Err("Comet couldn't find a free readable folder. Rename the conflicting folder in your cloud provider and sync again.".into())
}
async fn directory_listing(engine: &Engine, remote: &str, directory: &str, cache: &mut HashMap<String, Vec<serde_json::Value>>) -> Result<Vec<serde_json::Value>, String> {
    if let Some(entries) = cache.get(directory) { return Ok(entries.clone()); }
    let entries = engine.list(remote, directory).await?;
    cache.insert(directory.to_string(), entries.clone());
    Ok(entries)
}
/// Write one verified copy into the mirror. If the existing file no longer
/// matches what Comet previously wrote, it is preserved next to the new copy
/// instead of being silently replaced.
async fn mirror_file(engine: &Engine, remote: &str, group: &str, folder: &str, entry: &FileVersion, previous: Option<&FileVersion>, cache: &mut HashMap<String, Vec<serde_json::Value>>) -> Result<(), String> {
    let destination = format!("{folder}/{}", entry.path);
    let (directory, filename) = destination.rsplit_once('/').ok_or("Invalid readable cloud copy path.")?;
    engine.mkdir(remote, directory).await?;
    let existing = directory_listing(engine, remote, directory, cache).await?
        .into_iter().find(|item| item.get("Name").and_then(serde_json::Value::as_str) == Some(filename) && item.get("IsDir").and_then(serde_json::Value::as_bool) != Some(true));
    if existing.is_some() {
        let current = engine.read(remote, &destination, MAX_FILE + 1).await.ok().map(|bytes| (bytes.len() as u64, hash(&bytes)));
        if current.as_ref().is_some_and(|(size, digest)| *size == entry.size && digest == &entry.hash) { return Ok(()); }
        let untouched = match (previous, current) { (Some(previous), Some((size, digest))) => size == previous.size && digest == previous.hash, _ => false };
        if !untouched {
            let names: HashSet<String> = directory_listing(engine, remote, directory, cache).await?.iter().filter_map(|item| item.get("Name").and_then(serde_json::Value::as_str).map(str::to_string)).collect();
            let stamp = readable_timestamp(now_seconds()?);
            let mut candidate = preserved_name(filename, &stamp);
            while names.contains(&candidate) { candidate = preserved_name(filename, &format!("{stamp} {}", &new_id()?[..6])); }
            engine.copy(remote, &destination, &format!("{directory}/{candidate}"), MAX_FILE + 1).await?;
            cache.remove(directory);
        }
    }
    engine.copy(remote, &format!("{ROOT}/{group}/blobs/{}", entry.blob), &destination, entry.size as usize + 1).await?;
    let bytes = engine.read(remote, &destination, entry.size as usize + 1).await?;
    if bytes.len() as u64 != entry.size || hash(&bytes) != entry.hash || !text_content(&bytes) {
        return Err("A readable cloud copy failed verification. Synced originals remain safe.".into());
    }
    cache.remove(directory);
    Ok(())
}
/// Update the browseable mirror for a saved revision. Files changed since the
/// last mirrored revision are copied; unchanged files are left alone. Nothing
/// is ever deleted, and a failed batch is retried on the next sync.
async fn export_readable(engine: &Engine, remote: &str, group: &str, name: &str, revision: &str, manifest: &Manifest, parents: &[(&str, &Manifest)]) -> Result<Option<String>, String> {
    if !remote_ok(remote) || !group_id(group) || !object_id(revision) { return Err("Invalid cloud copy state.".into()); }
    validate_manifest(manifest, group)?;
    let marked = mirror_markers(engine, remote, group).await?;
    if marked.contains(revision) { return Ok(None); }
    for (_, parent) in parents { validate_manifest(parent, group)?; }
    let baseline = parents.iter().find(|(id, _)| marked.contains(*id)).map(|(_, manifest)| *manifest);
    let old: HashMap<&str, &FileVersion> = baseline.into_iter().flat_map(|manifest| manifest.entries.iter()).map(|entry| (entry.path.as_str(), entry)).collect();
    let mut previous: HashMap<&str, &FileVersion> = HashMap::new();
    for (_, manifest) in parents { for entry in &manifest.entries { previous.entry(entry.path.as_str()).or_insert(entry); } }
    let folder = mirror_folder(engine, remote, group, name).await?;
    let mut cache = HashMap::new();
    for entry in manifest.entries.iter().filter(|entry| !same(old.get(entry.path.as_str()).copied(), Some(*entry))) {
        mirror_file(engine, remote, group, &folder, entry, previous.get(entry.path.as_str()).copied(), &mut cache).await?;
    }
    let marker = format!("{ROOT}/{group}/mirror"); engine.mkdir(remote, &marker).await?;
    engine.upload(remote, &marker, &format!("{revision}.done"), &[]).await?;
    Ok(Some(folder))
}

fn current_matches(path: &Path, version: &FileVersion) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else { return false; };
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() != version.size || meta.len() > MAX_FILE as u64 { return false; }
    fs::read(path).ok().is_some_and(|bytes| bytes.len() as u64 == version.size && hash(&bytes) == version.hash)
}
/// Create just the structural parents needed by an incoming text file. Never
/// remove folders: they may contain media excluded from cloud sync.
fn ensure_parent(root: &Path, original: &str, mapped: &mut HashMap<String, String>, result: &mut MergeSummary) -> Result<String, String> {
    if original.is_empty() { return Ok(String::new()); }
    let mut remote = String::new(); let mut local = String::new();
    for part in original.split('/') {
        if !remote.is_empty() { remote.push('/'); } remote.push_str(part);
        if let Some(existing) = mapped.get(&remote) { local = existing.clone(); continue; }
        let next = if local.is_empty() { part.to_string() } else { format!("{local}/{part}") };
        let target = workspace_archive::path_under(root, &next)?;
        let resolved = match fs::symlink_metadata(&target) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => next,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&target).map_err(|_| "Couldn't create a synced folder.")?; next
            },
            Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => {
                // A local file occupies the incoming folder name. Keep it and
                // place the incoming subtree in a deterministic conflict folder.
                let digest = hash(remote.as_bytes()); let mut chosen = None;
                for index in 0..1000 {
                    let candidate = workspace_archive::conflict_path(&target, &digest[..8], index)?;
                    let relative = workspace_archive::relative_name(root, &candidate)?;
                    match fs::create_dir(&candidate) {
                        Ok(()) => { result.conflicts += 1; chosen = Some(relative); break; },
                        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                            if fs::symlink_metadata(&candidate).ok().is_some_and(|m| m.is_dir() && !m.file_type().is_symlink()) { chosen = Some(relative); break; }
                        },
                        Err(_) => return Err("Couldn't preserve a conflicting remote folder.".into()),
                    }
                }
                chosen.ok_or("Too many conflicting folders.")?
            },
            _ => return Err("A cloud sync path contains a symbolic link or unsupported item.".into()),
        };
        mapped.insert(remote.clone(), resolved.clone()); local = resolved;
    }
    Ok(local)
}
fn merge(vault: &str, local: &Snapshot, base: Option<&Manifest>, remote: &Manifest, downloaded: &HashMap<String, PathBuf>) -> Result<MergeSummary, String> {
    validate_manifest(remote, &remote.group)?;
    if let Some(base) = base { validate_manifest(base, &remote.group)?; }
    let root = workspace_root(vault)?;
    // Reject case-only collisions before writing, including local directories
    // that contain only excluded media. This is portable to case-insensitive OSes.
    let mut cases = local.cases.clone();
    for entry in &remote.entries { add_case_path(&mut cases, &entry.path)?; }
    let base_map: BTreeMap<&str, &FileVersion> = base.into_iter().flat_map(|m| m.entries.iter()).map(|e| (e.path.as_str(), e)).collect();
    let remote_map: BTreeMap<&str, &FileVersion> = remote.entries.iter().map(|e| (e.path.as_str(), e)).collect();
    let mut result = MergeSummary { applied: 0, conflicts: 0, deleted: 0, safety_folder: None, changed_paths: Vec::new() };
    let mut safety = None; let mut counter = 0usize; let mut mapped = HashMap::new();
    let attempt = (|| -> Result<(), String> {
        for (name, incoming) in &remote_map {
            let original = base_map.get(name).copied();
            if same(original, Some(incoming)) { continue; }
            let staged = downloaded.get(*name).ok_or("A verified incoming cloud file is missing.")?;
            let bytes = staged_bytes(staged, incoming)?;
            let (parent, leaf) = name.rsplit_once('/').unwrap_or(("", *name));
            let local_parent = ensure_parent(&root, parent, &mut mapped, &mut result)?;
            let relative = if local_parent.is_empty() { leaf.to_string() } else { format!("{local_parent}/{leaf}") };
            let target = workspace_archive::path_under(&root, &relative)?;
            let remapped = local_parent != parent;
            let here = if remapped { None } else { local.files.get(*name).map(|file| &file.version) };
            if same(here, Some(incoming)) || (remapped && current_matches(&target, incoming)) { continue; }
            let clean_update = !remapped && here.is_some() && same(here, original);
            if clean_update && current_matches(&target, here.unwrap()) {
                counter += 1; let saved = workspace_archive::save_original(&root, &target, &mut safety, counter)?;
                if !current_matches(&saved, here.unwrap()) {
                    // A racing writer changed the file after capture. Restore it
                    // and preserve incoming bytes as a separate conflict copy.
                    crate::rename_without_replace(&saved, &target).map_err(|_| "A local file changed during sync; its original is in the safety folder.")?;
                    if workspace_archive::conflict_copy(&root, &target, &bytes)? { result.conflicts += 1; }
                    continue;
                }
                match workspace_archive::atomic_write_new(&target, &bytes) {
                    Ok(()) => { result.applied += 1; result.changed_paths.push(relative); },
                    Err(_) => {
                        let _ = crate::rename_without_replace(&saved, &target);
                        return Err(format!("Couldn't apply a complete remote file. The local original, if not restored, is safe in {}.", saved.display()));
                    }
                }
            } else if here.is_some() || (!remapped && original.is_some()) {
                // Includes a local deletion versus a remote edit: retain the
                // deletion and preserve the incoming content under a new name.
                if workspace_archive::conflict_copy(&root, &target, &bytes)? { result.conflicts += 1; }
            } else {
                match workspace_archive::atomic_write_new(&target, &bytes) {
                    Ok(()) => { result.applied += 1; result.changed_paths.push(relative); },
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                        if workspace_archive::conflict_copy(&root, &target, &bytes)? { result.conflicts += 1; }
                    },
                    Err(_) => return Err("Couldn't create a complete synced file.".into()),
                }
            }
        }
        // Only remove a synced text file when its actual current contents are
        // still equal to the common ancestor. Move it to a safety folder first.
        for (name, old) in &base_map {
            if remote_map.contains_key(name) { continue; }
            let here = local.files.get(*name).map(|item| &item.version);
            if !same(here, Some(old)) { continue; }
            let target = workspace_archive::path_under(&root, name)?;
            if current_matches(&target, old) {
                counter += 1; let saved = workspace_archive::save_original(&root, &target, &mut safety, counter)?;
                if current_matches(&saved, old) { result.deleted += 1; result.changed_paths.push((*name).to_string()); }
                else { crate::rename_without_replace(&saved, &target).map_err(|_| "A local file changed during sync; its original is in the safety folder.")?; }
            }
        }
        Ok(())
    })();
    if let Err(error) = attempt { return Err(match &safety { Some(path) => format!("{error} Originals already moved are in {}.", path.display()), None => error }); }
    result.safety_folder = safety.map(|path| path.to_string_lossy().to_string()); Ok(result)
}

struct Job {
    prepared_at: Instant, ticket: String, vault: String, remote: String, group: String, base: String, name: String,
    parents: Vec<String>, manifests: Vec<Manifest>, ancestor: Option<Manifest>, incoming: Option<Manifest>,
    remote_id: Option<String>, remote_descends_base: bool, more: bool, downloads: usize,
    incoming_files: HashMap<String, PathBuf>, snapshot: Option<Snapshot>, stage: Stage, summary: MergeSummary,
    readable: HashSet<String>, recovered: bool,
}
fn acquire() -> bool {
    if SYNCING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok() { return true; }
    if let Ok(mut slot) = PREPARED.lock() {
        if slot.as_ref().is_some_and(|job| job.prepared_at.elapsed() > Duration::from_secs(120)) {
            slot.take(); SYNCING.store(false, Ordering::Release);
            return SYNCING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok();
        }
    }
    false
}
fn take_job(ticket: &str) -> Result<Job, String> {
    let mut slot = PREPARED.lock().map_err(|_| "Cloud sync state is unavailable.")?;
    if slot.as_ref().is_none_or(|job| job.ticket != ticket) { return Err("This cloud sync operation is no longer active.".into()); }
    slot.take().ok_or_else(|| "This cloud sync operation is no longer active.".into())
}
fn put_job(job: Job) -> Result<(), String> {
    let mut slot = PREPARED.lock().map_err(|_| "Cloud sync state is unavailable.")?;
    if slot.is_some() { return Err("Another cloud sync operation is active.".into()); }
    *slot = Some(job); Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared { ticket: String, incoming: bool }
#[tauri::command]
pub async fn rclone_incremental_prepare(app: tauri::AppHandle, vault: String, remote: String, group: String, base: String) -> Result<Prepared, String> {
    if !acquire() { return Err("A workspace sync is already running.".into()); }
    let guard = ConnectingGuard(&SYNCING);
    if !remote_ok(&remote) || (!group.is_empty() && !group_id(&group)) || (!base.is_empty() && !object_id(&base)) || (group.is_empty() != base.is_empty()) { return Err("Invalid cloud sync state.".into()); }
    workspace_root(&vault)?;
    let engine = Engine::start(app.clone()).await?;
    let stage = Stage::new(&app.path().app_cache_dir().map_err(|_| "Couldn't find Comet's cloud cache.")?)?;
    let display = Path::new(&vault).file_name().and_then(|v| v.to_str()).unwrap_or("Workspace").chars().filter(|c| !c.is_control() && !matches!(c, '/' | '\\')).take(100).collect::<String>();
    let group = if group.is_empty() { new_id()? } else { group };
    let mut job = Job { prepared_at: Instant::now(), ticket: new_id()?, vault, remote: remote.clone(), group: group.clone(), base: base.clone(), name: format!("Comet text sync - {display}"), parents: if base.is_empty() { Vec::new() } else { vec![base.clone()] }, manifests: Vec::new(), ancestor: None, incoming: None, remote_id: None, remote_descends_base: false, more: false, downloads: 0, incoming_files: HashMap::new(), snapshot: None, stage, summary: MergeSummary { applied: 0, conflicts: 0, deleted: 0, safety_folder: None, changed_paths: Vec::new() }, readable: HashSet::new(), recovered: false };
    if !base.is_empty() {
        let items = history(&engine, &remote, &group).await?;
        let revisions: Vec<_> = items.iter().map(|item| item.revision.clone()).collect();
        if let Some(root) = items.iter().filter(|item| item.revision.parents.is_empty()).min_by(|a, b| a.revision.id.cmp(&b.revision.id)) { job.name = root.revision.name.clone(); }
        job.readable = mirror_markers(&engine, &remote, &group).await.unwrap_or_default();
        let mut current = heads(&revisions); current.sort_by(|a,b| b.modified.cmp(&a.modified).then_with(|| a.id.cmp(&b.id)));
        if let Some(base_manifest) = items.iter().find(|item| item.revision.id == base).map(|item| item.manifest.clone()) {
            job.manifests.push(base_manifest);
            if current.is_empty() { return Err("The cloud sync history has no valid head. No local files were changed.".into()); }
            let base_ancestors = ancestor_distances(&base, &revisions);
            let next = current.iter().find(|head| head.id != base && !base_ancestors.contains_key(&head.id)).map(|item| item.id.clone());
            job.more = current.len() > 1;
            if let Some(next_id) = next {
                if let Some(id) = common_ancestor(&base, &next_id, &revisions) {
                    job.ancestor = Some(items.iter().find(|item| item.revision.id == id).map(|item| item.manifest.clone()).ok_or("A cloud ancestor is missing.")?);
                }
                let manifest = items.iter().find(|item| item.revision.id == next_id).map(|item| item.manifest.clone()).ok_or("A cloud revision is missing.")?;
                let (files, count) = download_changes(&engine, &remote, &group, job.ancestor.as_ref(), &manifest, &job.stage).await?;
                job.downloads = count; job.incoming_files = files;
                job.remote_descends_base = ancestor_distances(&next_id, &revisions).contains_key(&base);
                job.parents.push(next_id.clone()); job.remote_id = Some(next_id); job.incoming = Some(manifest.clone()); job.manifests.push(manifest);
            }
        } else if let Some(head) = current.first() {
            // The saved baseline no longer exists (for example, a provider that
            // never listed a just-published revision, or removed history).
            // Reconnect to the newest cloud head without assuming a shared
            // ancestor: remote files are imported and any difference is kept as
            // a conflict copy. Nothing is deleted on either side.
            job.recovered = true; job.base = String::new(); job.parents.clear(); job.manifests.clear();
            job.more = current.len() > 1;
            let id = head.id.clone();
            let manifest = items.iter().find(|item| item.revision.id == id).map(|item| item.manifest.clone()).ok_or("A cloud revision is missing.")?;
            let (files, count) = download_changes(&engine, &remote, &group, None, &manifest, &job.stage).await?;
            job.downloads = count; job.incoming_files = files;
            job.remote_descends_base = false; job.remote_id = Some(id.clone());
            job.parents.push(id); job.incoming = Some(manifest.clone()); job.manifests.push(manifest);
        } else {
            // The binding points at a group with no usable history. Publish a
            // fresh root; old cloud objects are never deleted.
            job.recovered = true; job.base = String::new(); job.parents.clear(); job.manifests.clear();
        }
    }
    let reply = Prepared { ticket: job.ticket.clone(), incoming: job.incoming.is_some() };
    job.prepared_at = Instant::now(); put_job(job)?; std::mem::forget(guard); Ok(reply)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied { applied: usize, deleted: usize, conflicts: usize, safety_folder: Option<String>, changed_paths: Vec<String>, recovered: bool }
#[tauri::command]
pub async fn rclone_incremental_apply(ticket: String) -> Result<Applied, String> {
    let mut job = take_job(&ticket)?;
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Job, String> {
        if let Some(incoming) = job.incoming.as_ref() {
            let local = snapshot(&job.vault, &job.stage)?;
            job.summary = merge(&job.vault, &local, job.ancestor.as_ref(), incoming, &job.incoming_files)?;
        }
        job.snapshot = Some(snapshot(&job.vault, &job.stage).map_err(|error| match &job.summary.safety_folder { Some(folder) => format!("{error} Originals already moved are in {folder}."), None => error })?);
        Ok(job)
    }).await.map_err(|_| "Local sync preparation was interrupted.".to_string()).and_then(|result| result);
    match result {
        Ok(job) => {
            let reply = Applied { applied: job.summary.applied, deleted: job.summary.deleted, conflicts: job.summary.conflicts, safety_folder: job.summary.safety_folder.clone(), changed_paths: job.summary.changed_paths.clone(), recovered: job.recovered };
            if let Err(error) = put_job(job) { SYNCING.store(false, Ordering::Release); return Err(error); } Ok(reply)
        },
        Err(error) => { SYNCING.store(false, Ordering::Release); Err(error) }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult { group: String, base: String, uploaded: usize, downloaded: usize, more: bool, readable_needed: bool }
#[tauri::command]
pub async fn rclone_incremental_publish(app: tauri::AppHandle, ticket: String) -> Result<SyncResult, String> {
    let job = take_job(&ticket)?; let _guard = ConnectingGuard(&SYNCING);
    let snapshot = job.snapshot.as_ref().ok_or("Sync must be applied before publication.")?;
    let existing = if !job.base.is_empty() && job.parents.len() == 1 && job.manifests.first().is_some_and(|m| snapshot_matches(snapshot, m)) { Some(job.base.clone()) }
        else if job.parents.len() == 2 && job.remote_descends_base && job.manifests.get(1).is_some_and(|m| snapshot_matches(snapshot, m)) { job.remote_id.clone() } else { None };
    let mut uploaded = 0;
    let id = if let Some(id) = existing { id } else {
        let engine = Engine::start(app).await?;
        let (manifest, count) = build_manifest(&engine, &job.remote, &job.group, &job.manifests, snapshot).await?; uploaded = count;
        let id = new_id()?;
        let revision = StoredRevision { version: 2, id: id.clone(), group: job.group.clone(), name: job.name.clone(), parents: job.parents.clone(), manifest };
        validate_revision(&revision, &id, &job.group)?;
        let data = serde_json::to_vec(&revision).map_err(|_| "Couldn't prepare cloud sync metadata.")?;
        if data.len() > MANIFEST_LIMIT { return Err("The cloud sync manifest is too large; local files remain safe.".into()); }
        let dir = format!("{ROOT}/{}/revisions", job.group); engine.mkdir(&job.remote, &dir).await?;
        engine.upload(&job.remote, &dir, &format!("{id}.json"), &data).await?;
        let check = engine.read(&job.remote, &format!("{dir}/{id}.json"), MANIFEST_LIMIT).await?;
        if check != data { return Err("Cloud revision verification failed; local files remain safe.".into()); }
        let commits = format!("{ROOT}/{}/commits", job.group); engine.mkdir(&job.remote, &commits).await?;
        let marker_name = format!("{id}-{}.commit", hash(&data));
        engine.upload(&job.remote, &commits, &marker_name, &[]).await?;
        // Do not make this revision the saved baseline until the provider can
        // list it. Otherwise a lagging listing would strand this device on a
        // baseline that its next check cannot find.
        let mut listed = false;
        for attempt in 0..4 {
            listed = engine.list(&job.remote, &commits).await?.iter().any(|entry| entry.get("Name").and_then(serde_json::Value::as_str) == Some(marker_name.as_str()));
            if listed { break; }
            if attempt < 3 { pause(750 + attempt as u64 * 750).await; }
        }
        if !listed { return Err("Cloud saved this revision but has not listed it yet. Comet will retry; local files are safe.".into()); }
        id
    };
    let readable_needed = !job.readable.contains(&id);
    Ok(SyncResult { group: job.group, base: id, uploaded, downloaded: job.downloads, more: job.more, readable_needed })
}
/// Run only after the revision baseline has been persisted by the renderer, so
/// an interrupted or failed optional copy cannot lose a successful sync.
#[tauri::command]
pub async fn rclone_export_readable(app: tauri::AppHandle, remote: String, group: String, id: String) -> Result<(), String> {
    if !remote_ok(&remote) || !group_id(&group) || !object_id(&id) { return Err("Invalid cloud copy state.".into()); }
    if SYNCING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() { return Err("A workspace sync is already running.".into()); }
    let _guard = ConnectingGuard(&SYNCING);
    let engine = Engine::start(app).await?;
    let items = history(&engine, &remote, &group).await?;
    let item = items.iter().find(|item| item.revision.id == id).ok_or("The cloud revision is missing.")?;
    let name = items.iter().filter(|item| item.revision.parents.is_empty()).min_by(|a, b| a.revision.id.cmp(&b.revision.id)).map(|root| root.revision.name.as_str()).unwrap_or(item.revision.name.as_str());
    let parents: Vec<_> = item.revision.parents.iter().filter_map(|parent| items.iter().find(|item| &item.revision.id == parent).map(|item| (parent.as_str(), &item.manifest))).collect();
    export_readable(&engine, &remote, &group, name, &id, &item.manifest, &parents).await.map(|_| ())
}
#[tauri::command]
pub fn rclone_incremental_abort(ticket: String) -> Result<(), String> { let _ = take_job(&ticket)?; SYNCING.store(false, Ordering::Release); Ok(()) }
#[tauri::command]
pub fn rclone_incremental_recover() -> Result<(), String> {
    let mut slot = PREPARED.lock().map_err(|_| "Cloud sync state is unavailable.")?;
    if slot.take().is_some() { SYNCING.store(false, Ordering::Release); } Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace { group: String, id: String, name: String, modified: String, branches: usize }
#[tauri::command]
pub async fn rclone_incremental_list(app: tauri::AppHandle, remote: String) -> Result<Vec<Workspace>, String> {
    if !remote_ok(&remote) { return Err("Invalid cloud account.".into()); }
    if SYNCING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() { return Err("A workspace sync is already running.".into()); }
    let _guard = ConnectingGuard(&SYNCING); let engine = Engine::start(app).await?;
    let mut groups = BTreeMap::new();
    for item in engine.list(&remote, ROOT).await? {
        if item.get("IsDir").and_then(serde_json::Value::as_bool) != Some(true) { continue; }
        if let Some(name) = item.get("Name").and_then(serde_json::Value::as_str).filter(|name| group_id(name)) { groups.insert(name.to_string(), ()); }
    }
    let mut result = Vec::new();
    for group in groups.keys() {
        let items = history(&engine, &remote, group).await?; let revisions: Vec<_> = items.iter().map(|i| i.revision.clone()).collect();
        let mut current = heads(&revisions); current.sort_by(|a,b| b.modified.cmp(&a.modified).then_with(|| a.id.cmp(&b.id)));
        if let Some(head) = current.first() { result.push(Workspace { group: group.clone(), id: head.id.clone(), name: head.name.clone(), modified: head.modified.clone(), branches: current.len() }); }
    }
    Ok(result)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Import { path: String, group: String, base: String }
fn import_files(parent: &Path, manifest: &Manifest, downloaded: &HashMap<String, PathBuf>) -> Result<PathBuf, String> {
    validate_manifest(manifest, &manifest.group)?;
    let parent = fs::canonicalize(parent).map_err(|_| "Couldn't open the chosen import folder.")?;
    if !parent.is_dir() { return Err("Choose a folder for the imported workspace.".into()); }
    let target = parent.join(format!("Comet import {}", &new_id()?[..16]));
    fs::create_dir(&target).map_err(|_| "Couldn't create a new import folder. No existing workspace was changed.")?;
    let attempt = (|| -> Result<(), String> {
        let mut mapped = HashMap::new();
        let mut summary = MergeSummary { applied: 0, conflicts: 0, deleted: 0, safety_folder: None, changed_paths: Vec::new() };
        for entry in &manifest.entries {
            let bytes = staged_bytes(downloaded.get(&entry.path).ok_or("A downloaded cloud file is missing.")?, entry)?;
            let (parent, leaf) = entry.path.rsplit_once('/').unwrap_or(("", entry.path.as_str()));
            let directory = ensure_parent(&target, parent, &mut mapped, &mut summary)?;
            if directory != parent { return Err("The new import folder changed unexpectedly. No existing workspace was changed.".into()); }
            let relative = if directory.is_empty() { leaf.to_string() } else { format!("{directory}/{leaf}") };
            let path = workspace_archive::path_under(&target, &relative)?;
            workspace_archive::atomic_write_new(&path, &bytes).map_err(|_| "Couldn't create a complete imported file.")?;
        }
        Ok(())
    })();
    if let Err(error) = attempt {
        // Only remove the random folder that this operation just created, and
        // never follow a substituted symlink or remove an existing workspace.
        if fs::symlink_metadata(&target).ok().is_some_and(|m| m.is_dir() && !m.file_type().is_symlink())
            && fs::canonicalize(&target).ok().and_then(|p| p.parent().map(Path::to_path_buf)).as_deref() == Some(parent.as_path()) { let _ = fs::remove_dir_all(&target); }
        return Err(error);
    }
    Ok(target)
}
#[tauri::command]
pub async fn rclone_incremental_import(app: tauri::AppHandle, remote: String, id: String, group: String) -> Result<Option<Import>, String> {
    if !remote_ok(&remote) || !object_id(&id) || !group_id(&group) { return Err("Invalid cloud workspace.".into()); }
    if SYNCING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() { return Err("A workspace sync is already running.".into()); }
    let _guard = ConnectingGuard(&SYNCING);
    let selected = app.dialog().file().set_title("Choose a folder for the synced workspace").blocking_pick_folder();
    let Some(parent) = selected.and_then(|path| path.into_path().ok()) else { return Ok(None); };
    let engine = Engine::start(app.clone()).await?; let items = history(&engine, &remote, &group).await?;
    let manifest = items.iter().find(|item| item.revision.id == id).map(|item| item.manifest.clone()).ok_or("This cloud revision is missing.")?;
    let stage = Stage::new(&app.path().app_cache_dir().map_err(|_| "Couldn't find Comet's cloud cache.")?)?;
    let (downloaded, _) = download_changes(&engine, &remote, &group, None, &manifest, &stage).await?;
    let path = tauri::async_runtime::spawn_blocking(move || { let _stage = stage; import_files(&parent, &manifest, &downloaded) }).await.map_err(|_| "The import was interrupted.")??;
    Ok(Some(Import { path: path.to_string_lossy().to_string(), group, base: id }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn area(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("comet-scoped-{label}-{}", new_id().unwrap()));
        fs::create_dir(&root).unwrap(); root
    }
    fn manifest(group: &str, snapshot: &Snapshot) -> Manifest {
        Manifest { version: 2, group: group.into(), entries: snapshot.files.values().map(|item| FileVersion { blob: "b".repeat(32), ..item.version.clone() }).collect() }
    }
    fn stages(snapshot: &Snapshot) -> HashMap<String, PathBuf> { snapshot.files.iter().map(|(name, item)| (name.clone(), item.staged.clone())).collect() }
    #[test]
    fn scope_rejects_media_binary_legacy_paths_and_traversal() {
        let root = area("scope"); let vault = root.join("vault"); let cache = root.join("cache"); fs::create_dir(&vault).unwrap();
        fs::create_dir(vault.join(".git")).unwrap(); fs::write(vault.join(".git/config"), "must not be sent").unwrap();
        fs::write(vault.join("note.MD"), "hello").unwrap(); fs::write(vault.join("sheet.csv"), "a,b\n1,2").unwrap();
        fs::write(vault.join("board.comet-whiteboard"), "{\"format\":\"comet-whiteboard\",\"image\":\"data:image/png;base64,AA==\"}").unwrap();
        fs::write(vault.join("tasks.comet-todo"), "{}").unwrap(); fs::write(vault.join("photo.jpg"), [0, 255, 1]).unwrap(); fs::write(vault.join("video.mp4"), [0, 1]).unwrap();
        fs::write(vault.join("book.pdf"), [0, 2]).unwrap(); fs::write(vault.join("shortcut.url"), "https://example.com").unwrap();
        let stage = Stage::new(&cache).unwrap(); let captured = snapshot(vault.to_str().unwrap(), &stage).unwrap();
        let names: Vec<_> = captured.files.keys().map(String::as_str).collect();
        assert_eq!(names, vec!["board.comet-whiteboard", "note.MD", "sheet.csv", "tasks.comet-todo"]);
        let group = "a".repeat(32); let mut m = manifest(&group, &captured); assert!(validate_manifest(&m, &group).is_ok());
        m.entries[0].path = "photo.jpg".into(); assert!(validate_manifest(&m, &group).is_err());
        m.entries[0].path = "../escape.md".into(); assert!(validate_manifest(&m, &group).is_err());
        m.entries[0].path = ".git/config".into(); assert!(validate_manifest(&m, &group).is_err());
        fs::write(vault.join("fake.txt"), [0, 1, 255]).unwrap();
        assert!(snapshot(vault.to_str().unwrap(), &stage).is_err(), "binary content under a text extension is not sent or treated as a deletion");
        drop(stage); fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn merges_changed_text_without_touching_excluded_media_and_keeps_both() {
        let root = area("merge"); let base = root.join("base"); let local = root.join("local"); let remote = root.join("remote");
        for dir in [&base, &local, &remote] {
            fs::create_dir_all(dir.join("folder")).unwrap();
            fs::write(dir.join("folder/conflict.md"), "ancestor").unwrap(); fs::write(dir.join("folder/delete.txt"), "old").unwrap();
            fs::write(dir.join("folder/unchanged.md"), "unchanged").unwrap();
        }
        let s = Stage::new(&root.join("cache")).unwrap(); let group = "c".repeat(32);
        let base_snapshot = snapshot(base.to_str().unwrap(), &s).unwrap(); let base_manifest = manifest(&group, &base_snapshot);
        fs::write(local.join("folder/conflict.md"), "local change").unwrap(); fs::write(local.join("folder/photo.png"), b"local media").unwrap();
        fs::write(remote.join("folder/conflict.md"), "remote change").unwrap(); fs::remove_file(remote.join("folder/delete.txt")).unwrap();
        fs::write(remote.join("folder/new.comet-todo"), "new board").unwrap();
        let local_snapshot = snapshot(local.to_str().unwrap(), &s).unwrap(); let incoming = snapshot(remote.to_str().unwrap(), &s).unwrap(); let remote_manifest = manifest(&group, &incoming);
        let result = merge(local.to_str().unwrap(), &local_snapshot, Some(&base_manifest), &remote_manifest, &stages(&incoming)).unwrap();
        assert_eq!(result.conflicts, 1); assert_eq!(result.deleted, 1);
        assert_eq!(fs::read(local.join("folder/photo.png")).unwrap(), b"local media");
        assert_eq!(fs::read_to_string(local.join("folder/conflict.md")).unwrap(), "local change");
        assert_eq!(fs::read_to_string(local.join("folder/new.comet-todo")).unwrap(), "new board");
        assert!(!local.join("folder/delete.txt").exists());
        let copies: Vec<_> = fs::read_dir(local.join("folder")).unwrap().map(Result::unwrap).filter(|entry| entry.file_name().to_string_lossy().starts_with("conflict (sync conflict ")).collect();
        assert_eq!(copies.len(), 1); assert_eq!(fs::read_to_string(copies[0].path()).unwrap(), "remote change");
        assert!(result.safety_folder.is_some());
        // A failed publication and retry must reuse the same conflict copy.
        let again = snapshot(local.to_str().unwrap(), &s).unwrap();
        merge(local.to_str().unwrap(), &again, Some(&base_manifest), &remote_manifest, &stages(&incoming)).unwrap();
        assert_eq!(fs::read_dir(local.join("folder")).unwrap().map(Result::unwrap).filter(|entry| entry.file_name().to_string_lossy().starts_with("conflict (sync conflict ")).count(), 1);
        drop(s); fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn remote_delete_does_not_remove_locally_changed_files_or_media_folders() {
        let root = area("delete"); let base = root.join("base"); let local = root.join("local"); let remote = root.join("remote");
        for dir in [&base, &local, &remote] { fs::create_dir_all(dir.join("folder")).unwrap(); }
        fs::write(base.join("folder/note.md"), "old").unwrap(); fs::write(local.join("folder/note.md"), "new local").unwrap();
        fs::write(local.join("folder/photo.png"), b"not synced").unwrap();
        let stage = Stage::new(&root.join("cache")).unwrap(); let group = "d".repeat(32);
        let old = manifest(&group, &snapshot(base.to_str().unwrap(), &stage).unwrap());
        let here = snapshot(local.to_str().unwrap(), &stage).unwrap(); let theirs = snapshot(remote.to_str().unwrap(), &stage).unwrap();
        let result = merge(local.to_str().unwrap(), &here, Some(&old), &manifest(&group, &theirs), &stages(&theirs)).unwrap();
        assert_eq!(result.deleted, 0); assert_eq!(fs::read_to_string(local.join("folder/note.md")).unwrap(), "new local"); assert!(local.join("folder/photo.png").exists());
        drop(stage); fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn files_larger_than_the_old_aggregate_archive_limit_are_staged_individually() {
        let root = area("large"); let vault = root.join("vault"); fs::create_dir(&vault).unwrap();
        let bytes = vec![b'x'; 15 * 1024 * 1024];
        for index in 0..9 { fs::write(vault.join(format!("{index}.txt")), &bytes).unwrap(); }
        let stage = Stage::new(&root.join("cache")).unwrap(); let captured = snapshot(vault.to_str().unwrap(), &stage).unwrap();
        assert_eq!(captured.files.len(), 9); assert!(captured.files.values().map(|item| item.version.size).sum::<u64>() > 128 * 1024 * 1024);
        assert!(validate_manifest(&manifest(&"e".repeat(32), &captured), &"e".repeat(32)).is_ok());
        drop(stage); fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn invalid_download_and_case_collisions_do_not_overwrite_local_files() {
        let root = area("invalid"); let local = root.join("local"); let remote = root.join("remote");
        fs::create_dir(&local).unwrap(); fs::create_dir(&remote).unwrap();
        fs::write(local.join("Note.md"), "local").unwrap(); fs::write(remote.join("note.md"), "incoming").unwrap();
        let stage = Stage::new(&root.join("cache")).unwrap(); let group = "f".repeat(32);
        let here = snapshot(local.to_str().unwrap(), &stage).unwrap(); let incoming = snapshot(remote.to_str().unwrap(), &stage).unwrap();
        assert!(merge(local.to_str().unwrap(), &here, None, &manifest(&group, &incoming), &stages(&incoming)).is_err());
        assert_eq!(fs::read_to_string(local.join("Note.md")).unwrap(), "local");
        fs::remove_file(local.join("Note.md")).unwrap(); let here = snapshot(local.to_str().unwrap(), &stage).unwrap();
        fs::write(&incoming.files.get("note.md").unwrap().staged, "corrupt").unwrap();
        assert!(merge(local.to_str().unwrap(), &here, None, &manifest(&group, &incoming), &stages(&incoming)).is_err());
        assert!(!local.join("note.md").exists());
        drop(stage); fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_without_uploading_their_contents() {
        use std::os::unix::fs::symlink;
        let root = area("symlink"); let vault = root.join("vault"); fs::create_dir(&vault).unwrap(); symlink(&root, vault.join("external")).unwrap();
        let stage = Stage::new(&root.join("cache")).unwrap(); assert!(snapshot(vault.to_str().unwrap(), &stage).is_err());
        drop(stage); fs::remove_dir_all(root).unwrap();
    }
    async fn commit(engine: &Engine, group: &str, id: &str, parents: Vec<String>, manifest: Manifest) {
        let stored = StoredRevision { version: 2, id: id.into(), group: group.into(), name: "Test".into(), parents, manifest };
        let data = serde_json::to_vec(&stored).unwrap(); let revisions = format!("{ROOT}/{group}/revisions"); let commits = format!("{ROOT}/{group}/commits");
        engine.mkdir("comet-google", &revisions).await.unwrap(); engine.mkdir("comet-google", &commits).await.unwrap();
        engine.upload("comet-google", &revisions, &format!("{id}.json"), &data).await.unwrap();
        engine.upload("comet-google", &commits, &format!("{id}-{}.commit", hash(&data)), &[]).await.unwrap();
    }
    #[test]
    fn readable_names_are_portable_and_preserved_names_keep_their_extension() {
        assert_eq!(readable_timestamp(0), "1970-01-01 00-00-00 UTC");
        assert_eq!(readable_timestamp(1_709_164_800), "2024-02-29 00-00-00 UTC");
        let name = mirror_name("Comet text sync - ../résumé?");
        assert!(!name.contains('/') && !name.contains(':') && !name.contains('?'));
        assert!(workspace_archive::safe_path(&name));
        assert_eq!(mirror_name("Comet text sync - CON"), "Workspace - CON");
        let preserved = preserved_name("Plan 100%.md", "2026-10-26 10-00-00 UTC");
        assert!(preserved.starts_with("Plan 100% (Comet preserved ") && preserved.ends_with(").md"));
        assert!(preserved.ends_with(".md") && workspace_archive::safe_path(&preserved));
    }
    #[test]
    fn local_rclone_mirrors_readable_files_in_place_without_losing_user_edits() {
        let Ok(exe) = std::env::var("COMET_RCLONE_TEST_BIN") else { return; };
        let root = area("mirror"); let remote = root.join("remote"); let vault = root.join("vault");
        fs::create_dir(&remote).unwrap(); fs::create_dir(&vault).unwrap(); fs::create_dir(vault.join("Résumé #1")).unwrap();
        fs::write(vault.join("Résumé #1/Plan 100%.md"), "initial").unwrap();
        fs::write(vault.join("tasks.comet-todo"), "{}").unwrap(); fs::write(vault.join("photo.jpg"), b"media").unwrap();
        tauri::async_runtime::block_on(async {
            let engine = Engine::for_test(exe.into(), root.clone()).await.unwrap();
            engine.call("config/create", serde_json::json!({"name":"comet-google","type":"alias","parameters":{"remote":remote.to_string_lossy()},"opt":{"nonInteractive":true}})).await.unwrap();
            let stage = Stage::new(&root.join("mirror-stage")).unwrap();
            let group = "a".repeat(32); let first = "b".repeat(32); let second = "c".repeat(32); let third = "e".repeat(32);
            let local = snapshot(vault.to_str().unwrap(), &stage).unwrap();
            let (base, _) = build_manifest(&engine, "comet-google", &group, &[], &local).await.unwrap();
            let folder = export_readable(&engine, "comet-google", &group, "Comet text sync - My notes", &first, &base, &[]).await.unwrap().unwrap();
            assert_eq!(folder, "Comet-Sync/My notes");
            assert!(remote.join("Comet-Sync/My notes").join(MIRROR_INFO).is_file());
            assert_eq!(fs::read(remote.join("Comet-Sync/My notes/Résumé #1/Plan 100%.md")).unwrap(), b"initial");
            assert!(remote.join("Comet-Sync/My notes/tasks.comet-todo").is_file());
            assert!(!remote.join("Comet-Sync/My notes/photo.jpg").exists());
            // A person edits the browseable copy; the next sync must keep it.
            fs::write(remote.join("Comet-Sync/My notes/Résumé #1/Plan 100%.md"), "user edited copy").unwrap();
            fs::write(vault.join("Résumé #1/Plan 100%.md"), "updated").unwrap();
            let changed = snapshot(vault.to_str().unwrap(), &stage).unwrap();
            let (next, _) = build_manifest(&engine, "comet-google", &group, &[base.clone()], &changed).await.unwrap();
            let again = export_readable(&engine, "comet-google", &group, "My notes", &second, &next, &[(&first.as_str(), &base)]).await.unwrap().unwrap();
            assert_eq!(again, "Comet-Sync/My notes");
            assert_eq!(fs::read(remote.join("Comet-Sync/My notes/Résumé #1/Plan 100%.md")).unwrap(), b"updated");
            let preserved: Vec<_> = fs::read_dir(remote.join("Comet-Sync/My notes/Résumé #1")).unwrap().map(Result::unwrap)
                .filter(|entry| entry.file_name().to_string_lossy().starts_with("Plan 100% (Comet preserved ")).collect();
            assert_eq!(preserved.len(), 1);
            assert_eq!(fs::read(preserved[0].path()).unwrap(), b"user edited copy");
            // Deleting a workspace file never deletes the readable copy.
            fs::remove_file(vault.join("tasks.comet-todo")).unwrap();
            let deleted = snapshot(vault.to_str().unwrap(), &stage).unwrap();
            let (last, _) = build_manifest(&engine, "comet-google", &group, &[next.clone()], &deleted).await.unwrap();
            export_readable(&engine, "comet-google", &group, "My notes", &third, &last, &[(&second.as_str(), &next)]).await.unwrap().unwrap();
            assert!(remote.join("Comet-Sync/My notes/tasks.comet-todo").is_file());
            assert!(export_readable(&engine, "comet-google", &group, "My notes", &third, &last, &[]).await.unwrap().is_none());
            // Files are direct children of the workspace folder, with no dated
            // Full copy/Changes subfolders.
            let names: Vec<_> = fs::read_dir(remote.join("Comet-Sync")).unwrap().map(Result::unwrap).map(|entry| entry.file_name().to_string_lossy().to_string()).collect();
            assert!(names.iter().any(|name| name.as_str() == "text-v2") && names.iter().any(|name| name.as_str() == "My notes"));
            assert!(!names.iter().any(|name| name.contains("Full copy") || name.contains("Changes") || name.as_str() == "Comet Files"));
            // A second workspace with the same display name gets its own folder.
            let other = "d".repeat(32);
            let claim = mirror_folder(&engine, "comet-google", &other, "My notes").await.unwrap();
            assert!(claim.starts_with("Comet-Sync/My notes (") && claim != folder);
            drop(engine); drop(stage);
        });
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn local_rclone_reuses_verified_history_cache_without_refetching_every_revision() {
        let Ok(exe) = std::env::var("COMET_RCLONE_TEST_BIN") else { return; };
        let root = area("history-cache"); let remote = root.join("remote"); let vault = root.join("vault");
        fs::create_dir(&remote).unwrap(); fs::create_dir(&vault).unwrap(); fs::write(vault.join("note.md"), "hello").unwrap();
        tauri::async_runtime::block_on(async {
            let engine = Engine::for_test(exe.into(), root.clone()).await.unwrap();
            engine.call("config/create", serde_json::json!({"name":"comet-google","type":"alias","parameters":{"remote":remote.to_string_lossy()},"opt":{"nonInteractive":true}})).await.unwrap();
            let stage = Stage::new(&root.join("cache-stage")).unwrap();
            let group = "a".repeat(32); let id = "b".repeat(32);
            let local = snapshot(vault.to_str().unwrap(), &stage).unwrap();
            let (base, _) = build_manifest(&engine, "comet-google", &group, &[], &local).await.unwrap();
            commit(&engine, &group, &id, vec![], base).await;
            assert_eq!(history(&engine, "comet-google", &group).await.unwrap().len(), 1);
            // The verified local copy avoids re-downloading every manifest on
            // each 30-second check.
            fs::write(remote.join(format!("Comet-Sync/text-v2/{group}/revisions/{id}.json")), b"tampered").unwrap();
            assert_eq!(history(&engine, "comet-google", &group).await.unwrap().len(), 1);
            fs::remove_dir_all(history_cache(&engine, &group).unwrap()).unwrap();
            assert!(history(&engine, "comet-google", &group).await.is_err());
            drop(engine); drop(stage);
        });
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn local_rclone_recovers_a_revision_whose_commit_marker_was_lost() {
        let Ok(exe) = std::env::var("COMET_RCLONE_TEST_BIN") else { return; };
        let root = area("commit-repair"); let remote = root.join("remote"); let vault = root.join("vault");
        fs::create_dir(&remote).unwrap(); fs::create_dir(&vault).unwrap(); fs::write(vault.join("note.md"), "hello").unwrap();
        tauri::async_runtime::block_on(async {
            let engine = Engine::for_test(exe.into(), root.clone()).await.unwrap();
            engine.call("config/create", serde_json::json!({"name":"comet-google","type":"alias","parameters":{"remote":remote.to_string_lossy()},"opt":{"nonInteractive":true}})).await.unwrap();
            let stage = Stage::new(&root.join("repair-stage")).unwrap();
            let group = "a".repeat(32); let id = "b".repeat(32);
            let local = snapshot(vault.to_str().unwrap(), &stage).unwrap();
            let (base, _) = build_manifest(&engine, "comet-google", &group, &[], &local).await.unwrap();
            commit(&engine, &group, &id, vec![], base).await;
            let commits = remote.join(format!("Comet-Sync/text-v2/{group}/commits"));
            for entry in fs::read_dir(&commits).unwrap() { fs::remove_file(entry.unwrap().path()).unwrap(); }
            let items = history(&engine, "comet-google", &group).await.unwrap();
            assert_eq!(items.len(), 1); assert_eq!(items[0].revision.id, id);
            assert!(fs::read_dir(&commits).unwrap().any(|entry| entry.unwrap().file_name().to_string_lossy().ends_with(".commit")));
            assert_eq!(history(&engine, "comet-google", &group).await.unwrap().len(), 1);
            drop(engine); drop(stage);
        });
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn local_rclone_transfers_only_changed_eligible_files_and_restores_both_conflicts() {
        let Ok(exe) = std::env::var("COMET_RCLONE_TEST_BIN") else { return; };
        let root = area("transport"); let remote = root.join("remote"); let first = root.join("a"); let second = root.join("b");
        for dir in [&remote, &first, &second] { fs::create_dir(dir).unwrap(); }
        for dir in [&first, &second] { fs::write(dir.join("note.md"), "before").unwrap(); fs::write(dir.join("same.txt"), "same").unwrap(); }
        fs::write(first.join("photo.jpg"), b"media stays local").unwrap();
        tauri::async_runtime::block_on(async {
            let mut engine = Engine::for_test(exe.clone().into(), root.clone()).await.unwrap();
            engine.call("config/create", serde_json::json!({"name":"comet-google","type":"alias","parameters":{"remote":remote.to_string_lossy()},"opt":{"nonInteractive":true}})).await.unwrap();
            let stage = Stage::new(&root.join("cache-stage")).unwrap(); let group = "1".repeat(32); let a = "2".repeat(32); let b = "3".repeat(32); let c = "4".repeat(32);
            let initial = snapshot(first.to_str().unwrap(), &stage).unwrap(); let (base, n) = build_manifest(&engine, "comet-google", &group, &[], &initial).await.unwrap(); assert_eq!(n, 2);
            assert!(history(&engine, "comet-google", &group).await.unwrap().is_empty());
            commit(&engine, &group, &a, vec![], base.clone()).await;
            engine.stop_for_test(); fs::write(first.join("note.md"), "offline A").unwrap();
            assert!(history(&engine, "comet-google", &group).await.is_err()); drop(engine);
            let engine = Engine::for_test(exe.into(), root.clone()).await.unwrap();
            fs::write(second.join("note.md"), "offline B").unwrap();
            let a_local = snapshot(first.to_str().unwrap(), &stage).unwrap(); let b_local = snapshot(second.to_str().unwrap(), &stage).unwrap();
            let (a_manifest, a_count) = build_manifest(&engine, "comet-google", &group, &[base.clone()], &a_local).await.unwrap();
            let (b_manifest, b_count) = build_manifest(&engine, "comet-google", &group, &[base.clone()], &b_local).await.unwrap();
            assert_eq!((a_count, b_count), (1, 1));
            commit(&engine, &group, &b, vec![a.clone()], a_manifest.clone()).await; commit(&engine, &group, &c, vec![a.clone()], b_manifest.clone()).await;
            let items = history(&engine, "comet-google", &group).await.unwrap(); assert_eq!(heads(&items.iter().map(|item| item.revision.clone()).collect::<Vec<_>>()).len(), 2);
            let (downloaded, count) = download_changes(&engine, "comet-google", &group, Some(&base), &b_manifest, &stage).await.unwrap(); assert_eq!(count, 1);
            let result = merge(first.to_str().unwrap(), &a_local, Some(&base), &b_manifest, &downloaded).unwrap(); assert_eq!(result.conflicts, 1);
            assert_eq!(fs::read_to_string(first.join("note.md")).unwrap(), "offline A"); assert_eq!(fs::read(first.join("photo.jpg")).unwrap(), b"media stays local");
            let merged = snapshot(first.to_str().unwrap(), &stage).unwrap(); let (joined, uploads) = build_manifest(&engine, "comet-google", &group, &[a_manifest, b_manifest], &merged).await.unwrap(); assert_eq!(uploads, 0);
            let (all, _) = download_changes(&engine, "comet-google", &group, None, &joined, &stage).await.unwrap();
            let imported = import_files(&root, &joined, &all).unwrap(); assert!(!imported.join("photo.jpg").exists());
            assert!(fs::read_dir(&imported).unwrap().map(Result::unwrap).any(|item| item.file_name().to_string_lossy().starts_with("note (sync conflict ")));
            drop(engine); drop(stage);
        });
        fs::remove_dir_all(root).unwrap();
    }
}
