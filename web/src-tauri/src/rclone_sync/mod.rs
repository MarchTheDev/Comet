//! Rclone is only the transport: Comet writes immutable content objects and
//! hash-checked revision manifests, then publishes a zero-byte commit marker.
//! No `sync`, `bisync`, mirror, remote deletion, or last-writer-wins copy is
//! used. Existing Google Drive v3 history is deliberately a separate protocol.
pub(crate) mod auth;
mod engine;

use auth::remote_ok;
use engine::Engine;
use crate::google::{ancestor_distances, common_ancestor, group_id, heads, ConnectingGuard, Revision, SYNCING};
use crate::google::incremental::{archive_matches, hash, hash_ok, read_cache, ticket as new_id, validate_history, validate_manifest, write_cache, Manifest, ManifestEntry, MANIFEST_LIMIT};
use crate::workspace_archive::{self, ArchiveEntry, MAX_ARCHIVE};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Mutex, atomic::Ordering};
use std::time::{Duration, Instant};
use tauri_plugin_dialog::DialogExt;

const ROOT: &str = "Comet-Sync/v1";
static PREPARED: Mutex<Option<Job>> = Mutex::new(None);
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StoredRevision { version: u8, id: String, group: String, name: String, parents: Vec<String>, manifest: Manifest }
struct Item { revision: Revision, manifest: Manifest }
fn object_id(id: &str) -> bool { id.len() == 32 && id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }
fn validate_revision(item: &StoredRevision, expected_id: &str, group: &str) -> Result<(), String> {
    if item.version != 1 || !object_id(expected_id) || item.id != expected_id || !group_id(group) || item.group != group || item.name.is_empty() || item.name.len() > 400 || item.name.chars().any(char::is_control)
        || item.parents.len() > 2 || item.parents.iter().any(|id| !object_id(id) || id == expected_id) || item.parents.iter().collect::<HashSet<_>>().len() != item.parents.len() {
        return Err("The cloud sync history has invalid metadata. No local files were changed.".into());
    }
    validate_manifest(&item.manifest, group)?;
    if item.manifest.entries.iter().any(|entry| entry.blob.as_deref().is_some_and(|id| !object_id(id))) { return Err("The cloud manifest has an invalid content identity.".into()); }
    Ok(())
}
fn marker(name: &str) -> Option<(&str, &str)> {
    let stem = name.strip_suffix(".commit")?; let (id, digest) = stem.split_once('-')?;
    (object_id(id) && hash_ok(digest)).then_some((id, digest))
}
async fn history(engine: &Engine, remote: &str, group: &str) -> Result<Vec<Item>, String> {
    if !remote_ok(remote) || !group_id(group) { return Err("Invalid cloud workspace.".into()); }
    let dir = format!("{ROOT}/{group}/commits"); let mut result = Vec::new(); let mut ids = HashSet::new();
    for entry in engine.list(remote, &dir).await? {
        if entry.get("IsDir").and_then(serde_json::Value::as_bool) == Some(true) { continue; }
        let name = entry.get("Name").and_then(serde_json::Value::as_str).ok_or("Cloud returned an invalid commit name.")?;
        if !name.ends_with(".commit") { continue; }
        let (id, expected) = marker(name).ok_or("Cloud returned an invalid commit marker. No local files were changed.")?;
        if entry.get("Size").and_then(serde_json::Value::as_u64) != Some(0) || !ids.insert(id.to_string()) { return Err("Cloud returned duplicate or damaged commit markers. No local files were changed.".into()); }
        let bytes = engine.read(remote, &format!("{ROOT}/{group}/revisions/{id}.json"), MANIFEST_LIMIT).await?;
        if hash(&bytes) != expected { return Err("A cloud revision failed verification. No local files were changed.".into()); }
        let stored: StoredRevision = serde_json::from_slice(&bytes).map_err(|_| "A cloud revision is damaged. No local files were changed.")?;
        validate_revision(&stored, id, group)?;
        let modified = entry.get("ModTime").and_then(serde_json::Value::as_str).unwrap_or("").chars().take(64).collect();
        result.push(Item { revision: Revision { id: id.into(), group: group.into(), name: stored.name, modified, parents: stored.parents }, manifest: stored.manifest });
    }
    let revisions: Vec<_> = result.iter().map(|item| item.revision.clone()).collect();
    validate_history(&revisions)?;
    Ok(result)
}
async fn materialize(engine: &Engine, remote: &str, group: &str, manifest: &Manifest, sources: &[&[u8]]) -> Result<(Vec<u8>, usize), String> {
    validate_manifest(manifest, group)?;
    let mut known: HashMap<(String, usize), Vec<u8>> = HashMap::new();
    for source in sources { for entry in workspace_archive::entries(source)? {
        if !entry.directory { known.entry((hash(entry.bytes), entry.bytes.len())).or_insert_with(|| entry.bytes.to_vec()); }
    } }
    let mut content: Vec<(String, bool, Vec<u8>)> = Vec::new(); let mut count = 0;
    for entry in &manifest.entries {
        if entry.directory { content.push((entry.path.clone(), true, Vec::new())); continue; }
        let digest = entry.hash.as_deref().ok_or("Missing cloud file hash.")?;
        let id = entry.blob.as_deref().filter(|id| object_id(id)).ok_or("Missing cloud content identity.")?;
        let size = usize::try_from(entry.size).map_err(|_| "Cloud file is too large.")?;
        let bytes = if let Some(bytes) = known.get(&(digest.to_string(), size)) { bytes.clone() } else {
            let bytes = engine.read(remote, &format!("{ROOT}/{group}/blobs/{id}"), size.saturating_add(1).min(MAX_ARCHIVE)).await?;
            if bytes.len() != size || hash(&bytes) != digest { return Err("A cloud file failed verification. No local files were changed.".into()); }
            count += 1; known.insert((digest.into(), size), bytes.clone()); bytes
        };
        content.push((entry.path.clone(), false, bytes));
    }
    let entries: Vec<ArchiveEntry<'_>> = content.iter().map(|(name, directory, bytes)| ArchiveEntry { name: name.clone(), directory: *directory, bytes: bytes.as_slice() }).collect();
    let archive = workspace_archive::assemble(entries)?;
    if !archive_matches(&archive, manifest) { return Err("The cloud workspace failed verification. No local files were changed.".into()); }
    Ok((archive, count))
}
async fn build_manifest(engine: &Engine, remote: &str, group: &str, manifests: &[Manifest], snapshot: &[u8]) -> Result<(Manifest, usize), String> {
    let mut known: HashMap<(String, u64), String> = HashMap::new();
    for manifest in manifests { for entry in &manifest.entries {
        if let (Some(hash), Some(id)) = (&entry.hash, &entry.blob) { if object_id(id) { known.entry((hash.clone(), entry.size)).or_insert_with(|| id.clone()); } }
    } }
    let dir = format!("{ROOT}/{group}/blobs"); engine.mkdir(remote, &dir).await?;
    let mut entries = Vec::new(); let mut count = 0;
    for entry in workspace_archive::entries(snapshot)? {
        if entry.directory { entries.push(ManifestEntry { path: entry.name, directory: true, size: 0, hash: None, blob: None }); continue; }
        let digest = hash(entry.bytes); let size = entry.bytes.len() as u64;
        let id = if let Some(id) = known.get(&(digest.clone(), size)) { id.clone() } else {
            let id = new_id()?;
            engine.upload(remote, &dir, &id, entry.bytes).await?;
            // Verify content before publishing a marker. An interrupted or
            // damaged object is unreferenced and never applied by another device.
            let check = engine.read(remote, &format!("{dir}/{id}"), entry.bytes.len().saturating_add(1).min(MAX_ARCHIVE)).await?;
            if check.len() != entry.bytes.len() || hash(&check) != digest { return Err("A cloud upload failed verification; local files remain safe.".into()); }
            known.insert((digest.clone(), size), id.clone()); count += 1; id
        };
        entries.push(ManifestEntry { path: entry.name, directory: false, size, hash: Some(digest), blob: Some(id) });
    }
    let manifest = Manifest { version: 3, group: group.into(), entries };
    validate_manifest(&manifest, group)?; Ok((manifest, count))
}
struct Job {
    prepared_at: Instant, ticket: String, vault: String, remote: String, group: String, base: String, name: String,
    parents: Vec<String>, manifests: Vec<Manifest>, ancestor: Option<Vec<u8>>, incoming: Option<Vec<u8>>,
    remote_id: Option<String>, remote_descends_base: bool, more: bool, downloads: usize, snapshot: Option<Vec<u8>>,
    summary: workspace_archive::MergeSummary,
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
    let engine = Engine::start(app.clone()).await?;
    let display = std::path::Path::new(&vault).file_name().and_then(|v| v.to_str()).unwrap_or("Workspace").chars().filter(|c| !c.is_control() && !matches!(c, '/' | '\\')).take(100).collect::<String>();
    let group = if group.is_empty() { new_id()? } else { group };
    let mut job = Job { prepared_at: Instant::now(), ticket: new_id()?, vault, remote: remote.clone(), group: group.clone(), base: base.clone(), name: format!("Comet sync - {display}"), parents: if base.is_empty() { Vec::new() } else { vec![base.clone()] }, manifests: Vec::new(), ancestor: None, incoming: None, remote_id: None, remote_descends_base: false, more: false, downloads: 0, snapshot: None, summary: workspace_archive::MergeSummary { applied: 0, conflicts: 0, deleted: 0, safety_folder: None, changed_paths: Vec::new() } };
    if !base.is_empty() {
        let items = history(&engine, &remote, &group).await?;
        let revisions: Vec<_> = items.iter().map(|item| item.revision.clone()).collect();
        let base_manifest = items.iter().find(|item| item.revision.id == base).map(|item| item.manifest.clone()).ok_or("The cloud sync baseline is missing. No local files were changed.")?;
        let base_cache = read_cache(&app, &group, &base, &base_manifest); job.manifests.push(base_manifest);
        let mut current = heads(&revisions); current.sort_by(|a,b| b.modified.cmp(&a.modified).then_with(|| a.id.cmp(&b.id)));
        if current.is_empty() { return Err("The cloud sync history has no valid head. No local files were changed.".into()); }
        let base_ancestors = ancestor_distances(&base, &revisions);
        let next = current.iter().find(|head| head.id != base && !base_ancestors.contains_key(&head.id)).map(|item| item.id.clone());
        job.more = current.len() > 1;
        if let Some(next_id) = next {
            if let Some(id) = common_ancestor(&base, &next_id, &revisions) {
                let manifest = items.iter().find(|item| item.revision.id == id).map(|item| &item.manifest).ok_or("A cloud ancestor is missing.")?;
                let archive = if let Some(bytes) = read_cache(&app, &group, &id, manifest) { bytes } else {
                    let sources: Vec<&[u8]> = base_cache.as_deref().into_iter().collect();
                    let (bytes, count) = materialize(&engine, &remote, &group, manifest, &sources).await?; job.downloads += count;
                    let _ = write_cache(&app, &group, &id, &bytes); bytes
                };
                job.ancestor = Some(archive);
            }
            let manifest = items.iter().find(|item| item.revision.id == next_id).map(|item| item.manifest.clone()).ok_or("A cloud revision is missing.")?;
            let incoming = if let Some(bytes) = read_cache(&app, &group, &next_id, &manifest) { bytes } else {
                let mut sources = Vec::new(); if let Some(bytes) = base_cache.as_deref() { sources.push(bytes); } if let Some(bytes) = job.ancestor.as_deref() { sources.push(bytes); }
                let (bytes, count) = materialize(&engine, &remote, &group, &manifest, &sources).await?; job.downloads += count;
                let _ = write_cache(&app, &group, &next_id, &bytes); bytes
            };
            job.remote_descends_base = ancestor_distances(&next_id, &revisions).contains_key(&base);
            job.parents.push(next_id.clone()); job.remote_id = Some(next_id); job.incoming = Some(incoming); job.manifests.push(manifest);
        }
    }
    let reply = Prepared { ticket: job.ticket.clone(), incoming: job.incoming.is_some() };
    job.prepared_at = Instant::now(); put_job(job)?; std::mem::forget(guard); Ok(reply)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied { applied: usize, deleted: usize, conflicts: usize, safety_folder: Option<String>, changed_paths: Vec<String> }
#[tauri::command]
pub async fn rclone_incremental_apply(ticket: String) -> Result<Applied, String> {
    let mut job = take_job(&ticket)?;
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Job, String> {
        if let Some(incoming) = job.incoming.as_deref() { job.summary = workspace_archive::merge(&job.vault, job.ancestor.as_deref(), incoming)?; }
        job.snapshot = Some(workspace_archive::pack(&job.vault).map_err(|error| match &job.summary.safety_folder { Some(folder) => format!("{error} Originals already moved are in {folder}."), None => error })?);
        Ok(job)
    }).await.map_err(|_| "Local sync preparation was interrupted.".to_string()).and_then(|result| result);
    match result {
        Ok(job) => {
            let reply = Applied { applied: job.summary.applied, deleted: job.summary.deleted, conflicts: job.summary.conflicts, safety_folder: job.summary.safety_folder.clone(), changed_paths: job.summary.changed_paths.clone() };
            if let Err(error) = put_job(job) { SYNCING.store(false, Ordering::Release); return Err(error); } Ok(reply)
        },
        Err(error) => { SYNCING.store(false, Ordering::Release); Err(error) }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult { group: String, base: String, uploaded: usize, downloaded: usize, more: bool }
#[tauri::command]
pub async fn rclone_incremental_publish(app: tauri::AppHandle, ticket: String) -> Result<SyncResult, String> {
    let job = take_job(&ticket)?; let _guard = ConnectingGuard(&SYNCING);
    let snapshot = job.snapshot.as_deref().ok_or("Sync must be applied before publication.")?;
    let existing = if job.parents.len() == 1 && job.manifests.first().is_some_and(|m| archive_matches(snapshot, m)) { Some(job.base.clone()) }
        else if job.parents.len() == 2 && job.remote_descends_base && job.manifests.get(1).is_some_and(|m| archive_matches(snapshot, m)) { job.remote_id.clone() } else { None };
    let mut uploaded = 0;
    let id = if let Some(id) = existing { id } else {
        let engine = Engine::start(app.clone()).await?;
        let (manifest, count) = build_manifest(&engine, &job.remote, &job.group, &job.manifests, snapshot).await?; uploaded = count;
        let id = new_id()?;
        let revision = StoredRevision { version: 1, id: id.clone(), group: job.group.clone(), name: job.name.clone(), parents: job.parents.clone(), manifest };
        validate_revision(&revision, &id, &job.group)?;
        let data = serde_json::to_vec(&revision).map_err(|_| "Couldn't prepare cloud sync metadata.")?;
        if data.len() > MANIFEST_LIMIT { return Err("The cloud sync manifest is too large; local files remain safe.".into()); }
        let dir = format!("{ROOT}/{}/revisions", job.group); engine.mkdir(&job.remote, &dir).await?;
        engine.upload(&job.remote, &dir, &format!("{id}.json"), &data).await?;
        let check = engine.read(&job.remote, &format!("{dir}/{id}.json"), MANIFEST_LIMIT).await?;
        if check != data { return Err("Cloud revision verification failed; local files remain safe.".into()); }
        let commits = format!("{ROOT}/{}/commits", job.group); engine.mkdir(&job.remote, &commits).await?;
        engine.upload(&job.remote, &commits, &format!("{id}-{}.commit", hash(&data)), &[]).await?;
        id
    };
    let _ = write_cache(&app, &job.group, &id, snapshot);
    Ok(SyncResult { group: job.group, base: id, uploaded, downloaded: job.downloads, more: job.more })
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
#[tauri::command]
pub async fn rclone_incremental_import(app: tauri::AppHandle, remote: String, id: String, group: String) -> Result<Option<Import>, String> {
    if !remote_ok(&remote) || !object_id(&id) || !group_id(&group) { return Err("Invalid cloud workspace.".into()); }
    if SYNCING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() { return Err("A workspace sync is already running.".into()); }
    let _guard = ConnectingGuard(&SYNCING);
    let selected = app.dialog().file().set_title("Choose a folder for the synced workspace").blocking_pick_folder();
    let Some(parent) = selected.and_then(|path| path.into_path().ok()) else { return Ok(None); };
    let engine = Engine::start(app.clone()).await?; let items = history(&engine, &remote, &group).await?;
    let manifest = items.iter().find(|item| item.revision.id == id).map(|item| &item.manifest).ok_or("This cloud revision is missing.")?;
    let archive = if let Some(bytes) = read_cache(&app, &group, &id, manifest) { bytes } else { materialize(&engine, &remote, &group, manifest, &[]).await?.0 };
    let copy = archive.clone(); let path = tauri::async_runtime::spawn_blocking(move || workspace_archive::unpack(&copy, &parent)).await.map_err(|_| "The import was interrupted.")??;
    let _ = write_cache(&app, &group, &id, &archive);
    Ok(Some(Import { path: path.to_string_lossy().to_string(), group, base: id }))
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn commit(engine: &Engine, group: &str, id: &str, parents: Vec<String>, manifest: Manifest) {
        let stored = StoredRevision { version: 1, id: id.into(), group: group.into(), name: "Test workspace".into(), parents, manifest };
        let data = serde_json::to_vec(&stored).unwrap();
        let revisions = format!("{ROOT}/{group}/revisions"); let commits = format!("{ROOT}/{group}/commits");
        engine.mkdir("comet-google", &revisions).await.unwrap(); engine.mkdir("comet-google", &commits).await.unwrap();
        engine.upload("comet-google", &revisions, &format!("{id}.json"), &data).await.unwrap();
        engine.upload("comet-google", &commits, &format!("{id}-{}.commit", hash(&data)), &[]).await.unwrap();
    }
    #[test]
    fn local_rclone_contract_encrypts_config_and_keeps_divergent_revisions() {
        let Ok(exe) = std::env::var("COMET_RCLONE_TEST_BIN") else { return; };
        let root = std::env::temp_dir().join(format!("comet-rclone-test-{}-{}", std::process::id(), new_id().unwrap()));
        let remote_root = root.join("remote"); std::fs::create_dir_all(&remote_root).unwrap();
        tauri::async_runtime::block_on(async {
            let engine = Engine::for_test(exe.into(), root.clone()).await.unwrap();
            engine.call("config/create", serde_json::json!({"name":"comet-google","type":"alias","parameters":{"remote":remote_root.to_string_lossy()},"opt":{"nonInteractive":true}})).await.unwrap();
            let config = std::fs::read_to_string(root.join("test.conf")).unwrap();
            assert!(config.contains("RCLONE_ENCRYPT_V0:")); assert!(!config.contains(remote_root.to_string_lossy().as_ref()));
            let group = "c".repeat(32); let a = "a".repeat(32); let b = "b".repeat(32); let d = "d".repeat(32);
            let base = workspace_archive::assemble(vec![ArchiveEntry { name: "same.md".into(), directory: false, bytes: b"same" }, ArchiveEntry { name: "edit.md".into(), directory: false, bytes: b"before" }]).unwrap();
            let changed = workspace_archive::assemble(vec![ArchiveEntry { name: "same.md".into(), directory: false, bytes: b"same" }, ArchiveEntry { name: "edit.md".into(), directory: false, bytes: b"after" }]).unwrap();
            let (first, count) = build_manifest(&engine, "comet-google", &group, &[], &base).await.unwrap(); assert_eq!(count, 2);
            // Uncommitted blobs by themselves are never considered a revision.
            assert!(history(&engine, "comet-google", &group).await.unwrap().is_empty());
            commit(&engine, &group, &a, vec![], first.clone()).await;
            let (next, count) = build_manifest(&engine, "comet-google", &group, &[first.clone()], &changed).await.unwrap(); assert_eq!(count, 1);
            commit(&engine, &group, &b, vec![a.clone()], next.clone()).await;
            commit(&engine, &group, &d, vec![a.clone()], first).await;
            let all = history(&engine, "comet-google", &group).await.unwrap();
            let revisions: Vec<_> = all.iter().map(|item| item.revision.clone()).collect(); assert_eq!(heads(&revisions).len(), 2);
            let (received, count) = materialize(&engine, "comet-google", &group, &next, &[&base]).await.unwrap(); assert_eq!(count, 1); assert!(archive_matches(&received, &next));
            let blob = next.entries.iter().find(|entry| entry.path == "edit.md").unwrap().blob.as_ref().unwrap();
            std::fs::write(remote_root.join(ROOT).join(&group).join("blobs").join(blob), b"wrong").unwrap();
            assert!(materialize(&engine, "comet-google", &group, &next, &[&base]).await.is_err());
            drop(engine);
        });
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn markers_and_revision_validation_reject_tampering() {
        let id = "a".repeat(32); let digest = "b".repeat(64);
        assert_eq!(marker(&format!("{id}-{digest}.commit")), Some((id.as_str(), digest.as_str())));
        assert!(marker("../bad.commit").is_none());
        let group = "c".repeat(32);
        let mut item = StoredRevision { version: 1, id: id.clone(), group: group.clone(), name: "Workspace".into(), parents: vec![], manifest: Manifest { version: 3, group: group.clone(), entries: vec![] } };
        assert!(validate_revision(&item, &id, &group).is_ok());
        item.parents.push(id.clone()); assert!(validate_revision(&item, &id, &group).is_err());
        item.parents.clear(); item.group = "different".into(); assert!(validate_revision(&item, &id, &group).is_err());
    }
}
