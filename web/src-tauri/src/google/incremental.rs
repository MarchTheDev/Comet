//! Incremental Drive sync. Immutable per-content blobs and manifests form a DAG,
//! so simultaneous devices cannot replace one another's writes. The existing
//! checked archive/three-way merge remains the local safety boundary.
//!
//! This first implementation retains the archive's 128 MiB / 20,000 item
//! bound; only changed file *contents* travel after a baseline is cached.
use super::*;
use crate::workspace_archive::{self, ArchiveEntry, MAX_ARCHIVE, MAX_ENTRIES};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

pub(crate) const MANIFEST_LIMIT: usize = 8 * 1024 * 1024;
#[cfg(test)]
static TEST_DRIVE_ORIGIN: Mutex<Option<String>> = Mutex::new(None);
fn drive_url(path: &str) -> String {
    #[cfg(test)]
    if let Some(origin) = TEST_DRIVE_ORIGIN.lock().ok().and_then(|guard| guard.clone()) { return format!("{origin}{path}"); }
    format!("https://www.googleapis.com{path}")
}

static PREPARED: Mutex<Option<Job>> = Mutex::new(None);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Manifest {
    pub(crate) version: u8,
    pub(crate) group: String,
    pub(crate) entries: Vec<ManifestEntry>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ManifestEntry {
    pub(crate) path: String,
    pub(crate) directory: bool,
    pub(crate) size: u64,
    pub(crate) hash: Option<String>,
    pub(crate) blob: Option<String>,
}
pub(crate) fn hash(bytes: &[u8]) -> String { Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect() }
pub(crate) fn hash_ok(value: &str) -> bool { value.len() == 64 && value.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)) }
pub(crate) fn validate_manifest(manifest: &Manifest, group: &str) -> Result<(), String> {
    if manifest.version != 3 || !group_id(group) || manifest.group != group || manifest.entries.len() > MAX_ENTRIES {
        return Err("Invalid incremental workspace manifest. Nothing was changed.".into());
    }
    let mut names = HashMap::new();
    let mut total = 42u64;
    for entry in &manifest.entries {
        if !workspace_archive::safe_path(&entry.path) || names.insert(entry.path.to_lowercase(), entry.directory).is_some() {
            return Err("The sync manifest has an unsafe or duplicate path. Nothing was changed.".into());
        }
        if entry.directory {
            if entry.size != 0 || entry.hash.is_some() || entry.blob.is_some() { return Err("Invalid synced folder.".into()); }
        } else if !entry.hash.as_deref().is_some_and(hash_ok) || !entry.blob.as_deref().is_some_and(drive_id) {
            return Err("Invalid synced file metadata. Nothing was changed.".into());
        }
        total = total.checked_add(13 + entry.path.len() as u64).and_then(|n| n.checked_add(entry.size)).ok_or("The sync manifest is too large.")?;
        if total > MAX_ARCHIVE as u64 { return Err("This workspace exceeds the 128 MB sync limit. Local files were preserved.".into()); }
    }
    for entry in &manifest.entries {
        let mut parent = entry.path.as_str();
        while let Some((head, _)) = parent.rsplit_once('/') {
            if names.get(&head.to_lowercase()) != Some(&true) { return Err("The sync manifest has a missing or conflicting folder.".into()); }
            parent = head;
        }
    }
    Ok(())
}
pub(crate) fn fingerprint_archive(bytes: &[u8]) -> Result<BTreeMap<String, (bool, u64, Option<String>)>, String> {
    Ok(workspace_archive::entries(bytes)?.into_iter().map(|entry| {
        let digest = if entry.directory { None } else { Some(hash(entry.bytes)) };
        (entry.name, (entry.directory, entry.bytes.len() as u64, digest))
    }).collect())
}
pub(crate) fn fingerprint_manifest(manifest: &Manifest) -> BTreeMap<String, (bool, u64, Option<String>)> {
    manifest.entries.iter().map(|entry| (entry.path.clone(), (entry.directory, entry.size, entry.hash.clone()))).collect()
}
pub(crate) fn archive_matches(bytes: &[u8], manifest: &Manifest) -> bool {
    fingerprint_archive(bytes).ok().is_some_and(|actual| actual == fingerprint_manifest(manifest))
}

fn revision3(value: &Value) -> Option<Revision> {
    let id = value.get("id")?.as_str()?.to_string();
    let props = value.get("appProperties")?.as_object()?;
    let group = props.get("cometGroup")?.as_str()?.to_string();
    if !drive_id(&id) || !group_id(&group) || props.get("cometSync")?.as_str()? != "3" { return None; }
    let mut parents = Vec::new();
    for key in ["parentA", "parentB"] {
        if let Some(value) = props.get(key) {
            let parent = value.as_str()?;
            if !drive_id(parent) || parent == id || parents.iter().any(|p| p == parent) { return None; }
            parents.push(parent.to_string());
        }
    }
    Some(Revision { id, group, name: value.get("name").and_then(Value::as_str).unwrap_or("Comet workspace").chars().take(150).collect(), modified: value.get("modifiedTime").and_then(Value::as_str).unwrap_or("").to_string(), parents })
}
async fn revisions3(access: &str) -> Result<Vec<Revision>, String> {
    let client = drive_client()?; let mut result = Vec::new(); let mut page = String::new();
    for _ in 0..100 {
        let response = client.get(drive_url("/drive/v3/files")).bearer_auth(access)
            .query(&[("q", "trashed = false and appProperties has { key='cometSync' and value='3' }"), ("fields", "nextPageToken,incompleteSearch,files(id,name,modifiedTime,appProperties)"), ("pageSize", "1000"), ("pageToken", page.as_str())])
            .send().await.map_err(|_| "Couldn't reach Google Drive. Your changes remain on this device.")?;
        let data = response_json(response).await?;
        if data.get("incompleteSearch").and_then(Value::as_bool) == Some(true) { return Err("Google returned an incomplete sync history. No files were changed; retry later.".into()); }
        if let Some(files) = data.get("files") {
            let files = files.as_array().ok_or("Google returned an invalid sync history.")?;
            for item in files { result.push(revision3(item).ok_or("Google returned invalid sync metadata. No files were changed.")?); }
        }
        page = data.get("nextPageToken").and_then(Value::as_str).unwrap_or("").to_string();
        if page.is_empty() { return Ok(result); }
        if page.len() > 2000 { return Err("Google returned an invalid page token.".into()); }
    }
    Err("Too many sync revisions to list safely. No files were changed.".into())
}
pub(crate) fn validate_history(revisions: &[Revision]) -> Result<(), String> {
    let ids: HashSet<&str> = revisions.iter().map(|item| item.id.as_str()).collect();
    if ids.len() != revisions.len() || revisions.iter().any(|item| item.parents.iter().any(|p| !ids.contains(p.as_str()))) {
        return Err("The cloud sync history is incomplete. No local files were changed; restore missing revisions or reconnect the original account.".into());
    }
    let mut remaining: HashMap<&str, usize> = revisions.iter().map(|item| (item.id.as_str(), item.parents.len())).collect();
    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    for item in revisions { for parent in &item.parents { children.entry(parent.as_str()).or_default().push(item.id.as_str()); } }
    let mut roots: Vec<&str> = remaining.iter().filter_map(|(id, count)| (*count == 0).then_some(*id)).collect();
    let mut seen = 0;
    while let Some(id) = roots.pop() {
        seen += 1;
        if let Some(next) = children.get(id) { for child in next {
            if let Some(count) = remaining.get_mut(child) { *count -= 1; if *count == 0 { roots.push(child); } }
        } }
    }
    if seen != revisions.len() { return Err("The cloud sync history contains a cycle. No local files were changed.".into()); }
    Ok(())
}
async fn media(access: &str, id: &str, limit: usize) -> Result<Vec<u8>, String> {
    if !drive_id(id) { return Err("Invalid Drive file ID.".into()); }
    let mut response = drive_client()?.get(drive_url(&format!("/drive/v3/files/{id}")))
        .query(&[("alt", "media")]).bearer_auth(access).send().await.map_err(|_| "The Drive download was interrupted; local files were preserved.")?;
    if !response.status().is_success() || response.content_length().is_some_and(|size| size > limit as u64) { return Err("A Drive sync file is missing or too large. No local files were changed.".into()); }
    let mut result = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "The Drive download was interrupted; local files were preserved.")? {
        if result.len().checked_add(chunk.len()).is_none_or(|n| n > limit) { return Err("A Drive sync file exceeds the allowed size.".into()); }
        result.extend_from_slice(&chunk);
    }
    Ok(result)
}
async fn metadata(access: &str, id: &str) -> Result<Value, String> {
    if !drive_id(id) { return Err("Invalid Drive file ID.".into()); }
    let response = drive_client()?.get(drive_url(&format!("/drive/v3/files/{id}")))
        .query(&[("fields", "id,name,modifiedTime,appProperties,size,trashed")]).bearer_auth(access).send().await.map_err(|_| "Couldn't reach Google Drive.")?;
    response_json(response).await
}
async fn get_manifest(access: &str, id: &str, group: &str) -> Result<Manifest, String> {
    let meta = metadata(access, id).await?;
    if meta.get("trashed").and_then(Value::as_bool) == Some(true) || !revision3(&meta).is_some_and(|r| r.id == id && r.group == group) { return Err("This sync revision is missing or belongs to another workspace.".into()); }
    let bytes = media(access, id, MANIFEST_LIMIT).await?;
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| "The Drive sync manifest is damaged. Nothing was changed.")?;
    validate_manifest(&manifest, group)?;
    Ok(manifest)
}
async fn get_blob(access: &str, group: &str, entry: &ManifestEntry) -> Result<Vec<u8>, String> {
    let id = entry.blob.as_deref().ok_or("Missing synced file ID.")?;
    let digest = entry.hash.as_deref().ok_or("Missing synced file hash.")?;
    let meta = metadata(access, id).await?;
    if meta.get("trashed").and_then(Value::as_bool) == Some(true)
        || meta.get("id").and_then(Value::as_str) != Some(id)
        || meta.pointer("/appProperties/cometBlob").and_then(Value::as_str) != Some("3")
        || meta.pointer("/appProperties/cometGroup").and_then(Value::as_str) != Some(group)
        || meta.pointer("/appProperties/cometHash").and_then(Value::as_str) != Some(digest)
        || meta.get("size").and_then(Value::as_str).and_then(|s| s.parse::<u64>().ok()) != Some(entry.size) {
        return Err("A synced file is missing or has invalid metadata. No local files were changed.".into());
    }
    let bytes = media(access, id, entry.size as usize).await?;
    if bytes.len() as u64 != entry.size || hash(&bytes) != digest { return Err("A synced file failed its checksum. No local files were changed.".into()); }
    Ok(bytes)
}
async fn materialize(access: &str, group: &str, manifest: &Manifest, sources: &[&[u8]]) -> Result<(Vec<u8>, usize), String> {
    validate_manifest(manifest, group)?;
    let mut available: HashMap<String, &[u8]> = HashMap::new();
    for source in sources {
        for entry in workspace_archive::entries(source)? { if !entry.directory { available.entry(hash(entry.bytes)).or_insert(entry.bytes); } }
    }
    let mut downloaded: HashMap<String, Vec<u8>> = HashMap::new(); let mut count = 0;
    for entry in manifest.entries.iter().filter(|e| !e.directory) {
        let digest = entry.hash.as_ref().ok_or("Missing file hash.")?;
        if available.get(digest).is_some_and(|bytes| bytes.len() as u64 == entry.size) || downloaded.contains_key(digest) { continue; }
        downloaded.insert(digest.clone(), get_blob(access, group, entry).await?); count += 1;
    }
    let mut entries = Vec::with_capacity(manifest.entries.len());
    for entry in &manifest.entries {
        let bytes: &[u8] = if entry.directory { &[] } else {
            let digest = entry.hash.as_ref().ok_or("Missing file hash.")?;
            available.get(digest).copied().or_else(|| downloaded.get(digest).map(Vec::as_slice)).ok_or("Missing downloaded file.")?
        };
        if bytes.len() as u64 != entry.size { return Err("Synced file size mismatch. Nothing was changed.".into()); }
        entries.push(ArchiveEntry { name: entry.path.clone(), directory: entry.directory, bytes });
    }
    let archive = workspace_archive::assemble(entries)?;
    if !archive_matches(&archive, manifest) { return Err("The synced workspace failed verification. Nothing was changed.".into()); }
    Ok((archive, count))
}

fn cache_dir(app: &tauri::AppHandle, group: &str) -> Result<PathBuf, String> {
    if !group_id(group) { return Err("Invalid sync cache identity.".into()); }
    let base = app.path().app_cache_dir().map_err(|_| "Couldn't open the local sync cache.")?;
    fs::create_dir_all(&base).map_err(|_| "Couldn't create the local sync cache.")?;
    let mut root = fs::canonicalize(base).map_err(|_| "Couldn't open the local sync cache.")?;
    for name in ["drive-incremental", group] {
        let next = root.join(name);
        match fs::create_dir(&next) { Ok(()) => {}, Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}, Err(_) => return Err("Couldn't create the local sync cache.".into()) }
        let meta = fs::symlink_metadata(&next).map_err(|_| "Couldn't inspect the local sync cache.")?;
        if !meta.is_dir() || meta.file_type().is_symlink() { return Err("The local sync cache isn't a safe folder.".into()); }
        let resolved = fs::canonicalize(&next).map_err(|_| "Couldn't open the local sync cache.")?;
        if resolved.parent() != Some(root.as_path()) { return Err("The local sync cache points outside its folder.".into()); }
        root = resolved;
    }
    Ok(root)
}
pub(crate) fn read_cache(app: &tauri::AppHandle, group: &str, id: &str, manifest: &Manifest) -> Option<Vec<u8>> {
    if !drive_id(id) { return None; }
    let path = cache_dir(app, group).ok()?.join(format!("{id}.comet-cache"));
    let meta = fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() > MAX_ARCHIVE as u64 { return None; }
    let bytes = fs::read(path).ok()?;
    archive_matches(&bytes, manifest).then_some(bytes)
}
pub(crate) fn write_cache(app: &tauri::AppHandle, group: &str, id: &str, bytes: &[u8]) -> Result<(), String> {
    if !drive_id(id) || bytes.len() > MAX_ARCHIVE { return Err("Invalid sync cache item.".into()); }
    let dir = cache_dir(app, group)?;
    let target = dir.join(format!("{id}.comet-cache"));
    let mut nonce = [0u8; 8]; getrandom::fill(&mut nonce).map_err(|_| "Couldn't prepare the sync cache.")?;
    let temp = dir.join(format!(".cache-{:x}.tmp", u64::from_le_bytes(nonce)));
    let mut file = OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|_| "Couldn't write the sync cache.")?;
    let write = file.write_all(bytes).and_then(|_| file.sync_all()); drop(file);
    if write.is_err() { let _ = fs::remove_file(&temp); return Err("Couldn't write the sync cache.".into()); }
    // Cache files are disposable. A corrupt existing cache must not prevent
    // retaining a verified baseline; never follow links while removing it.
    if target.exists() { let _ = fs::remove_file(&target); }
    if crate::rename_without_replace(&temp, &target).is_err() { let _ = fs::remove_file(&temp); return Err("Couldn't save the sync cache.".into()); }
    // Keep a small, disposable working set. Old ancestors remain on Drive and
    // can be reconstructed; this only removes files under the app cache.
    let mut caches: Vec<_> = fs::read_dir(&dir).ok().into_iter().flatten().filter_map(Result::ok)
        .filter(|item| item.file_name().to_str().is_some_and(|name| name.strip_suffix(".comet-cache").is_some_and(drive_id)))
        .filter_map(|item| item.metadata().ok().map(|m| (item.path(), m.modified().ok())))
        .collect();
    caches.sort_by(|a, b| b.1.cmp(&a.1));
    let mut older_kept = 0usize;
    for (path, _) in caches {
        if path == target { continue; }
        if older_kept < 2 { older_kept += 1; } else { let _ = fs::remove_file(path); }
    }
    Ok(())
}
async fn upload(access: &str, name: &str, props: Value, bytes: &[u8]) -> Result<String, String> {
    let mut nonce = [0u8; 16]; getrandom::fill(&mut nonce).map_err(|_| "Couldn't prepare the Drive upload.")?;
    let boundary = format!("comet{:x}", u128::from_le_bytes(nonce));
    let meta = serde_json::to_string(&json!({"name":name,"mimeType":"application/octet-stream","appProperties":props})).map_err(|_| "Couldn't prepare the Drive upload.")?;
    let mut body = format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n").into_bytes();
    body.extend_from_slice(bytes); body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let response = drive_client()?.post(drive_url("/upload/drive/v3/files")).query(&[("uploadType", "multipart"), ("fields", "id")])
        .bearer_auth(access).header("Content-Type", format!("multipart/related; boundary={boundary}")).body(body).send().await
        .map_err(|_| "The Drive upload was interrupted. Local changes remain available and will be retried.")?;
    let result = response_json(response).await?;
    result.get("id").and_then(Value::as_str).filter(|id| drive_id(id)).map(str::to_string).ok_or("Google returned an invalid uploaded file ID.".into())
}

async fn build_manifest(access: &str, group: &str, manifests: &[Manifest], snapshot: &[u8]) -> Result<(Manifest, usize), String> {
    let mut uploaded = 0usize;
    let mut known: HashMap<String, (u64, String)> = HashMap::new();
    for manifest in manifests { for entry in &manifest.entries {
        if let (Some(digest), Some(blob)) = (&entry.hash, &entry.blob) { known.entry(digest.clone()).or_insert((entry.size, blob.clone())); }
    } }
    let mut entries = Vec::new();
    for entry in workspace_archive::entries(snapshot)? {
        if entry.directory { entries.push(ManifestEntry { path: entry.name, directory: true, size: 0, hash: None, blob: None }); continue; }
        let digest = hash(entry.bytes); let size = entry.bytes.len() as u64;
        let blob = if let Some((known_size, id)) = known.get(&digest).filter(|(known_size, _)| *known_size == size) { let _ = known_size; id.clone() } else {
        let id = upload(access, &format!("Comet file {}", &digest[..16]), json!({"cometBlob":"3","cometGroup":group,"cometHash":digest}), entry.bytes).await?;
        known.insert(digest.clone(), (size, id.clone())); uploaded += 1; id
        };
        entries.push(ManifestEntry { path: entry.name, directory: false, size, hash: Some(digest), blob: Some(blob) });
    }
    let manifest = Manifest { version: 3, group: group.to_string(), entries };
    validate_manifest(&manifest, group)?;
    Ok((manifest, uploaded))
}

struct Job {
    prepared_at: Instant,
    ticket: String,
    vault: String,
    group: String,
    base: String,
    name: String,
    parents: Vec<String>,
    manifests: Vec<Manifest>,
    ancestor: Option<Vec<u8>>,
    incoming: Option<Vec<u8>>,
    remote_id: Option<String>,
    remote_descends_base: bool,
    more: bool,
    downloads: usize,
    snapshot: Option<Vec<u8>>,
    summary: workspace_archive::MergeSummary,
}
// If a webview vanishes while a network preparation is completing, its ticket
// can be orphaned. Only an idle job in the slot may expire; active apply or
// upload operations have already taken it out and can never be reclaimed here.
fn acquire_sync() -> bool {
    if SYNCING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok() { return true; }
    if let Ok(mut slot) = PREPARED.lock() {
        if slot.as_ref().is_some_and(|job| job.prepared_at.elapsed() > Duration::from_secs(120)) {
            slot.take(); SYNCING.store(false, Ordering::Release);
            return SYNCING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_ok();
        }
    }
    false
}
pub(crate) fn ticket() -> Result<String, String> {
    let mut nonce = [0u8; 16]; getrandom::fill(&mut nonce).map_err(|_| "Couldn't start sync.")?;
    Ok(nonce.iter().map(|b| format!("{b:02x}")).collect())
}
fn take_job(ticket: &str) -> Result<Job, String> {
    let mut slot = PREPARED.lock().map_err(|_| "Sync state is unavailable.")?;
    if slot.as_ref().is_none_or(|job| job.ticket != ticket) { return Err("This sync operation is no longer active.".into()); }
    slot.take().ok_or("This sync operation is no longer active.".into())
}
fn put_job(job: Job) -> Result<(), String> {
    let mut slot = PREPARED.lock().map_err(|_| "Sync state is unavailable.")?;
    if slot.is_some() { return Err("Another sync operation is active.".into()); }
    *slot = Some(job); Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared { ticket: String, incoming: bool }
#[tauri::command]
pub async fn google_incremental_prepare(app: tauri::AppHandle, vault: String, group: String, base: String) -> Result<Prepared, String> {
    if !acquire_sync() { return Err("A workspace sync is already running.".into()); }
    let guard = ConnectingGuard(&SYNCING);
    if (!group.is_empty() && !group_id(&group)) || (!base.is_empty() && !drive_id(&base)) || (group.is_empty() != base.is_empty()) { return Err("Invalid workspace sync state.".into()); }
    let access = token("drive").await?;
    let display = std::path::Path::new(&vault).file_name().and_then(|value| value.to_str()).unwrap_or("Workspace").chars().filter(|c| !c.is_control() && !matches!(c, '/' | '\\')).take(100).collect::<String>();
    let group = if group.is_empty() { ticket()? } else { group };
    let mut job = Job { prepared_at: Instant::now(), ticket: ticket()?, vault, group: group.clone(), base: base.clone(), name: format!("Comet sync - {display}"), parents: if base.is_empty() { Vec::new() } else { vec![base.clone()] }, manifests: Vec::new(), ancestor: None, incoming: None, remote_id: None, remote_descends_base: false, more: false, downloads: 0, snapshot: None, summary: workspace_archive::MergeSummary { applied: 0, conflicts: 0, deleted: 0, safety_folder: None, changed_paths: Vec::new() } };
    if !base.is_empty() {
        let all = revisions3(&access).await?;
        let history: Vec<_> = all.into_iter().filter(|r| r.group == group).collect();
        validate_history(&history)?;
        if !history.iter().any(|r| r.id == base) { return Err("The sync baseline is missing from Google Drive. No local files were changed.".into()); }
        let base_manifest = get_manifest(&access, &base, &group).await?;
        let base_cache = read_cache(&app, &group, &base, &base_manifest);
        job.manifests.push(base_manifest);
        let mut current_heads = heads(&history); current_heads.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.id.cmp(&b.id)));
        if current_heads.is_empty() { return Err("The sync history has no valid head. No local files were changed.".into()); }
        let base_ancestors = ancestor_distances(&base, &history);
        let remote = current_heads.iter().find(|head| head.id != base && !base_ancestors.contains_key(&head.id)).map(|item| item.id.clone());
        job.more = current_heads.len() > 1;
        if let Some(remote_id) = remote {
            let ancestor_id = common_ancestor(&base, &remote_id, &history);
            if let Some(id) = ancestor_id {
                let manifest = if id == base { job.manifests[0].clone() } else { get_manifest(&access, &id, &group).await? };
                let archive = if let Some(cached) = read_cache(&app, &group, &id, &manifest) { cached } else {
                    let sources: Vec<&[u8]> = base_cache.as_deref().into_iter().collect();
                    let (bytes, count) = materialize(&access, &group, &manifest, &sources).await?; job.downloads += count;
                    let _ = write_cache(&app, &group, &id, &bytes); bytes
                };
                job.ancestor = Some(archive);
            }
            let incoming_manifest = get_manifest(&access, &remote_id, &group).await?;
            let incoming = if let Some(cached) = read_cache(&app, &group, &remote_id, &incoming_manifest) { cached } else {
                let mut sources = Vec::new();
                if let Some(bytes) = base_cache.as_deref() { sources.push(bytes); }
                if let Some(bytes) = job.ancestor.as_deref() { sources.push(bytes); }
                let (bytes, count) = materialize(&access, &group, &incoming_manifest, &sources).await?; job.downloads += count;
                let _ = write_cache(&app, &group, &remote_id, &bytes); bytes
            };
            job.remote_descends_base = ancestor_distances(&remote_id, &history).contains_key(&base);
            job.parents.push(remote_id.clone()); job.remote_id = Some(remote_id); job.incoming = Some(incoming); job.manifests.push(incoming_manifest);
        }
    }
    let reply = Prepared { ticket: job.ticket.clone(), incoming: job.incoming.is_some() };
    job.prepared_at = Instant::now();
    put_job(job)?;
    // The guard is released by publish or abort, not when preparation returns.
    std::mem::forget(guard);
    Ok(reply)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied { applied: usize, deleted: usize, conflicts: usize, safety_folder: Option<String>, changed_paths: Vec<String> }
#[tauri::command]
pub async fn google_incremental_apply(ticket: String) -> Result<Applied, String> {
    let mut job = take_job(&ticket)?;
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Job, String> {
        if let Some(incoming) = job.incoming.as_deref() { job.summary = workspace_archive::merge(&job.vault, job.ancestor.as_deref(), incoming)?; }
        job.snapshot = Some(workspace_archive::pack(&job.vault).map_err(|error| match &job.summary.safety_folder {
            Some(folder) => format!("{error} Originals already moved are in {folder}."), None => error,
        })?);
        Ok(job)
    }).await.map_err(|_| "Local sync preparation was interrupted.".to_string()).and_then(|result| result);
    match result {
        Ok(job) => {
            let reply = Applied { applied: job.summary.applied, deleted: job.summary.deleted, conflicts: job.summary.conflicts, safety_folder: job.summary.safety_folder.clone(), changed_paths: job.summary.changed_paths.clone() };
            if let Err(error) = put_job(job) { SYNCING.store(false, Ordering::Release); return Err(error); }
            Ok(reply)
        },
        Err(error) => { SYNCING.store(false, Ordering::Release); Err(error) }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncrementalResult { group: String, base: String, uploaded: usize, downloaded: usize, more: bool }
#[tauri::command]
pub async fn google_incremental_publish(app: tauri::AppHandle, ticket: String) -> Result<IncrementalResult, String> {
    let job = take_job(&ticket)?;
    let _guard = ConnectingGuard(&SYNCING);
    let snapshot = job.snapshot.as_deref().ok_or("Sync must be applied before publication.")?;
    let access = token("drive").await?;
    let existing = if job.parents.len() == 1 && job.manifests.first().is_some_and(|m| archive_matches(snapshot, m)) { Some(job.base.clone()) }
        else if job.parents.len() == 2 && job.remote_descends_base && job.manifests.get(1).is_some_and(|m| archive_matches(snapshot, m)) { job.remote_id.clone() }
        else { None };
    let mut uploaded = 0usize;
    let id = if let Some(id) = existing { id } else {
        let (manifest, count) = build_manifest(&access, &job.group, &job.manifests, snapshot).await?;
        uploaded = count;
        let data = serde_json::to_vec(&manifest).map_err(|_| "Couldn't prepare the sync manifest.")?;
        if data.len() > MANIFEST_LIMIT { return Err("The sync manifest is too large. Local files were preserved.".into()); }
        let mut props = serde_json::Map::new();
        props.insert("cometSync".into(), json!("3")); props.insert("cometGroup".into(), json!(job.group));
        if let Some(parent) = job.parents.first() { props.insert("parentA".into(), json!(parent)); }
        if let Some(parent) = job.parents.get(1) { props.insert("parentB".into(), json!(parent)); }
        upload(&access, &job.name, Value::Object(props), &data).await?
    };
    // A failed cache write is safe: the next run reconstructs from Drive.
    let _ = write_cache(&app, &job.group, &id, snapshot);
    Ok(IncrementalResult { group: job.group, base: id, uploaded, downloaded: job.downloads, more: job.more })
}
#[tauri::command]
pub fn google_incremental_abort(ticket: String) -> Result<(), String> {
    let _ = take_job(&ticket)?;
    SYNCING.store(false, Ordering::Release); Ok(())
}
/// A webview reload loses its ticket. Discard only an idle prepared job; a
/// job actively applying/publishing has already been taken out of the slot.
#[tauri::command]
pub fn google_incremental_recover() -> Result<(), String> {
    let mut slot = PREPARED.lock().map_err(|_| "Sync state is unavailable.")?;
    if slot.take().is_some() { SYNCING.store(false, Ordering::Release); }
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncrementalWorkspace { group: String, id: String, name: String, modified: String, branches: usize }
#[tauri::command]
pub async fn google_incremental_list() -> Result<Vec<IncrementalWorkspace>, String> {
    let access = token("drive").await?; let all = revisions3(&access).await?;
    let mut groups: BTreeMap<String, Vec<Revision>> = BTreeMap::new();
    for item in all { groups.entry(item.group.clone()).or_default().push(item); }
    let mut result = Vec::new();
    for (group, items) in groups {
        validate_history(&items)?;
        let mut current = heads(&items); current.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.id.cmp(&b.id)));
        if let Some(head) = current.first() { result.push(IncrementalWorkspace { group, id: head.id.clone(), name: head.name.clone(), modified: head.modified.clone(), branches: current.len() }); }
    }
    Ok(result)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncrementalImport { path: String, group: String, base: String }
#[tauri::command]
pub async fn google_incremental_import(app: tauri::AppHandle, id: String, group: String) -> Result<Option<IncrementalImport>, String> {
    if !drive_id(&id) || !group_id(&group) { return Err("Invalid synced workspace.".into()); }
    if SYNCING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() { return Err("A workspace sync is already running.".into()); }
    let _guard = ConnectingGuard(&SYNCING);
    let selected = app.dialog().file().set_title("Choose a folder for the synced workspace").blocking_pick_folder();
    let Some(parent) = selected.and_then(|path| path.into_path().ok()) else { return Ok(None); };
    let access = token("drive").await?; let manifest = get_manifest(&access, &id, &group).await?;
    let archive = if let Some(bytes) = read_cache(&app, &group, &id, &manifest) { bytes } else { materialize(&access, &group, &manifest, &[]).await?.0 };
    let copy = archive.clone();
    let path = tauri::async_runtime::spawn_blocking(move || workspace_archive::unpack(&copy, &parent)).await.map_err(|_| "The import was interrupted.")??;
    let _ = write_cache(&app, &group, &id, &archive);
    Ok(Some(IncrementalImport { path: path.to_string_lossy().to_string(), group, base: id }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn group() -> String { "a".repeat(32) }
    fn file(path: &str, bytes: &[u8]) -> ManifestEntry { ManifestEntry { path: path.into(), directory: false, size: bytes.len() as u64, hash: Some(hash(bytes)), blob: Some("blob123".into()) } }
    #[test]
    fn manifests_validate_paths_folders_and_content_identity() {
        let manifest = Manifest { version: 3, group: group(), entries: vec![ManifestEntry { path: "Folder".into(), directory: true, size: 0, hash: None, blob: None }, file("Folder/note.md", b"hello")] };
        assert!(validate_manifest(&manifest, &group()).is_ok());
        let data = workspace_archive::assemble(vec![ArchiveEntry { name: "Folder".into(), directory: true, bytes: &[] }, ArchiveEntry { name: "Folder/note.md".into(), directory: false, bytes: b"hello" }]).unwrap();
        assert!(archive_matches(&data, &manifest));
        let mut changed = manifest.clone(); changed.entries[1].hash = Some(hash(b"other")); assert!(!archive_matches(&data, &changed));
        changed.entries[1] = file("../escape", b"x"); assert!(validate_manifest(&changed, &group()).is_err());
        changed.entries[1] = file("missing/note", b"x"); assert!(validate_manifest(&changed, &group()).is_err());
        changed.entries.push(file("folder", b"x")); assert!(validate_manifest(&changed, &group()).is_err());
        assert!(validate_manifest(&manifest, &"b".repeat(32)).is_err());
    }
    #[test]
    fn history_requires_all_parents_and_rejects_bad_ids() {
        let entry = |id: &str, parents: &[&str]| Revision { id: id.into(), group: group(), name: "vault".into(), modified: String::new(), parents: parents.iter().map(|s| s.to_string()).collect() };
        assert!(validate_history(&[entry("root", &[]), entry("left", &["root"]), entry("right", &["root"])]).is_ok());
        assert!(validate_history(&[entry("child", &["missing"])]).is_err());
        assert!(validate_history(&[entry("root", &[]), entry("a", &["b"]), entry("b", &["a"])]).is_err());
        assert!(revision3(&json!({"id":"../bad", "appProperties":{"cometSync":"3","cometGroup":group()}})).is_none());
    }
}

#[cfg(test)]
mod drive_contract_tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
    use std::thread;

    #[derive(Default)]
    struct MockDrive { files: HashMap<String, (Value, Vec<u8>)>, uploads: usize, downloads: usize }
    fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> { haystack.windows(needle.len()).position(|window| window == needle) }
    fn reply(stream: &mut TcpStream, code: &str, content_type: &str, body: &[u8]) {
        let _ = write!(stream, "HTTP/1.1 {code}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
        let _ = stream.write_all(body);
    }
    fn serve(mut stream: TcpStream, state: &Arc<Mutex<MockDrive>>) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut request = Vec::new(); let mut chunk = [0u8; 8192];
        let header_end = loop {
            match stream.read(&mut chunk) { Ok(0) | Err(_) => return, Ok(n) => request.extend_from_slice(&chunk[..n]) }
            if let Some(end) = find(&request, b"\r\n\r\n") { break end + 4; }
            if request.len() > 64 * 1024 { return; }
        };
        let headers = String::from_utf8_lossy(&request[..header_end]).to_string();
        let length = headers.lines().find_map(|line| line.split_once(':').filter(|(name, _)| name.eq_ignore_ascii_case("content-length")).and_then(|(_, value)| value.trim().parse::<usize>().ok())).unwrap_or(0);
        while request.len() < header_end + length {
            match stream.read(&mut chunk) { Ok(0) | Err(_) => return, Ok(n) => request.extend_from_slice(&chunk[..n]) }
        }
        let target = headers.lines().next().and_then(|line| line.split_whitespace().nth(1)).unwrap_or("");
        if target.starts_with("/upload/drive/v3/files?") {
            let Some(boundary) = headers.lines().find_map(|line| line.split_once("boundary=").map(|(_, value)| value.trim())) else { return; };
            let body = &request[header_end..header_end + length];
            let Some(meta_start) = find(body, b"\r\n\r\n").map(|n| n + 4) else { return; };
            let marker = format!("\r\n--{boundary}\r\n");
            let Some(meta_length) = find(&body[meta_start..], marker.as_bytes()) else { return; };
            let Ok(meta) = serde_json::from_slice::<Value>(&body[meta_start..meta_start + meta_length]) else { return; };
            let media_header = meta_start + meta_length + marker.len();
            let Some(media_start) = find(&body[media_header..], b"\r\n\r\n").map(|n| media_header + n + 4) else { return; };
            let end_marker = format!("\r\n--{boundary}--\r\n");
            let Some(media_len) = find(&body[media_start..], end_marker.as_bytes()) else { return; };
            let bytes = body[media_start..media_start + media_len].to_vec();
            let mut db = state.lock().unwrap(); db.uploads += 1; let id = format!("blob{}", db.uploads);
            let response_meta = json!({"id":id,"appProperties":meta["appProperties"],"size":bytes.len().to_string(),"trashed":false});
            db.files.insert(id.clone(), (response_meta, bytes)); drop(db);
            reply(&mut stream, "200 OK", "application/json", json!({"id":id}).to_string().as_bytes());
        } else if let Some(rest) = target.strip_prefix("/drive/v3/files/") {
            let (id, query) = rest.split_once('?').unwrap_or((rest, ""));
            let mut db = state.lock().unwrap();
            let Some((meta, bytes)) = db.files.get(id).cloned() else { reply(&mut stream, "404 Not Found", "text/plain", b"missing"); return; };
            if query.contains("alt=media") { db.downloads += 1; drop(db); reply(&mut stream, "200 OK", "application/octet-stream", &bytes); }
            else { drop(db); reply(&mut stream, "200 OK", "application/json", meta.to_string().as_bytes()); }
        } else { reply(&mut stream, "404 Not Found", "text/plain", b"missing"); }
    }
    #[test]
    fn changed_files_only_transfer_and_corrupt_download_is_rejected() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap(); let address = listener.local_addr().unwrap();
        let state = Arc::new(Mutex::new(MockDrive::default())); let server_state = state.clone();
        let stopped = Arc::new(AtomicBool::new(false)); let server_stopped = stopped.clone();
        let server = thread::spawn(move || { while !server_stopped.load(Ordering::Acquire) { if let Ok((stream, _)) = listener.accept() { if server_stopped.load(Ordering::Acquire) { break; } serve(stream, &server_state); } } });
        *TEST_DRIVE_ORIGIN.lock().unwrap() = Some(format!("http://{address}"));
        let group = "a".repeat(32);
        let base = workspace_archive::assemble(vec![ArchiveEntry { name: "same.md".into(), directory: false, bytes: b"unchanged" }, ArchiveEntry { name: "edit.md".into(), directory: false, bytes: b"before" }]).unwrap();
        let changed = workspace_archive::assemble(vec![ArchiveEntry { name: "same.md".into(), directory: false, bytes: b"unchanged" }, ArchiveEntry { name: "edit.md".into(), directory: false, bytes: b"after" }]).unwrap();
        tauri::async_runtime::block_on(async {
            let (original, first_uploads) = build_manifest("token", &group, &[], &base).await.unwrap();
            assert_eq!(first_uploads, 2);
            let (revised, next_uploads) = build_manifest("token", &group, &[original], &changed).await.unwrap();
            assert_eq!(next_uploads, 1, "unchanged content must reuse its immutable blob");
            let (received, downloaded) = materialize("token", &group, &revised, &[&base]).await.unwrap();
            assert_eq!(downloaded, 1); assert!(archive_matches(&received, &revised));
            let id = revised.entries.iter().find(|entry| entry.path == "edit.md").unwrap().blob.clone().unwrap();
            state.lock().unwrap().files.get_mut(&id).unwrap().1 = b"wrong".to_vec();
            assert!(materialize("token", &group, &revised, &[&base]).await.is_err(), "corrupted Drive bytes must not produce an archive");
        });
        let db = state.lock().unwrap(); assert_eq!(db.uploads, 3); assert_eq!(db.downloads, 2); drop(db);
        *TEST_DRIVE_ORIGIN.lock().unwrap() = None; stopped.store(true, Ordering::Release); let _ = TcpStream::connect(address); server.join().unwrap();
    }
}
