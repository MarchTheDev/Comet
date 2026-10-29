//! A short-lived, authenticated loopback rclone RC process. The RC API can
//! run commands and read files, so it is never exposed to the network or to
//! the renderer. Credentials travel only in loopback JSON, not in arguments.
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;

const EMBEDDED: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/comet-rclone"));
const CONFIG_SERVICE: &str = "com.marco.comet.rclone";
const CONFIG_ACCOUNT: &str = "encrypted-config-key";
const RC_USER: &str = "comet";
const ERROR: &str = "Cloud connection failed. Check your connection or reconnect the provider; local files are safe and will be retried.";

fn nonce() -> Result<String, String> {
    let mut bytes = [0u8; 32]; getrandom::fill(&mut bytes).map_err(|_| "Couldn't create secure cloud connection data.")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn checked_folder(base: &Path, name: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(base).map_err(|_| "Couldn't open Comet's local cloud data folder.")?;
    let base = fs::canonicalize(base).map_err(|_| "Couldn't open Comet's local cloud data folder.")?;
    let result = base.join(name);
    match fs::create_dir(&result) { Ok(()) => {}, Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}, Err(_) => return Err("Couldn't create Comet's local cloud data folder.".into()) }
    let meta = fs::symlink_metadata(&result).map_err(|_| "Couldn't inspect Comet's local cloud data folder.")?;
    if !meta.is_dir() || meta.file_type().is_symlink() || fs::canonicalize(&result).ok().and_then(|p| p.parent().map(Path::to_path_buf)).as_deref() != Some(base.as_path()) {
        return Err("The cloud data folder is not a safe local folder.".into());
    }
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&result, fs::Permissions::from_mode(0o700)).map_err(|_| "Couldn't protect the local cloud data folder.")?; }
    Ok(result)
}
fn file_hash(path: &Path) -> Option<Vec<u8>> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.file_type().is_symlink() { return None; }
    let mut file = File::open(path).ok()?; let mut digest = Sha256::new(); let mut buf = [0u8; 64 * 1024];
    loop { let n = file.read(&mut buf).ok()?; if n == 0 { break; } digest.update(&buf[..n]); }
    Some(digest.finalize().to_vec())
}
fn executable(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // Explicitly limited to development builds; release users get only the
    // executable that CI pinned and embedded.
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("COMET_RCLONE_DEV_BIN") {
        let path = PathBuf::from(path);
        if path.is_file() { return Ok(path); }
    }
    if EMBEDDED.is_empty() { return Err("This development build does not include rclone. Use a bundled release or set COMET_RCLONE_DEV_BIN for local development.".into()); }
    let root = checked_folder(&app.path().app_data_dir().map_err(|_| "Couldn't locate Comet's local data.")?, "rclone")?;
    let target = root.join(if cfg!(windows) { "rclone-v1.75.2.exe" } else { "rclone-v1.75.2" });
    let expected = Sha256::digest(EMBEDDED).to_vec();
    if file_hash(&target).as_ref() == Some(&expected) { return Ok(target); }
    if fs::symlink_metadata(&target).is_ok() { return Err("The bundled rclone executable was changed. Remove the local rclone cache and restart Comet.".into()); }
    let temp = root.join(format!(".rclone-{}.tmp", nonce()?));
    let mut file = OpenOptions::new().write(true).create_new(true).open(&temp).map_err(|_| "Couldn't unpack bundled rclone.")?;
    let result = file.write_all(EMBEDDED).and_then(|_| file.sync_all()); drop(file);
    if result.is_err() { let _ = fs::remove_file(&temp); return Err("Couldn't unpack bundled rclone.".into()); }
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; fs::set_permissions(&temp, fs::Permissions::from_mode(0o700)).map_err(|_| "Couldn't protect bundled rclone.")?; }
    if crate::rename_without_replace(&temp, &target).is_err() {
        let _ = fs::remove_file(&temp);
        if file_hash(&target).as_ref() != Some(&expected) { return Err("Couldn't install bundled rclone safely.".into()); }
    }
    Ok(target)
}
fn config_key(path: &Path) -> Result<String, String> {
    let entry = keyring::Entry::new(CONFIG_SERVICE, CONFIG_ACCOUNT).map_err(|_| "The system credential store is unavailable. Cloud sign-in is disabled.")?;
    let exists = match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => {
            let mut header = [0u8; 128]; let mut file = File::open(path).map_err(|_| "Couldn't read the encrypted cloud configuration.")?;
            let n = file.read(&mut header).map_err(|_| "Couldn't read the encrypted cloud configuration.")?;
            if !String::from_utf8_lossy(&header[..n]).contains("RCLONE_ENCRYPT_V0:") { return Err("The cloud configuration is not encrypted. Comet refused to open it.".into()); }
            true
        },
        Ok(_) => return Err("The cloud configuration is not a safe file.".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err("Couldn't inspect the cloud configuration.".into()),
    };
    match entry.get_password() {
        Ok(key) if !key.is_empty() => Ok(key),
        Err(keyring::Error::NoEntry) if !exists => {
            let key = nonce()?;
            entry.set_password(&key).map_err(|_| "The system credential store is unavailable. Cloud sign-in is disabled.")?;
            Ok(key)
        },
        _ => Err("The cloud encryption key is unavailable in the system credential store. No credentials were changed.".into()),
    }
}

pub struct Engine { child: Child, _job: ParentJob, origin: String, password: String, http: Client }
impl Drop for Engine {
    fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); }
}
impl Engine {
    pub async fn start(app: tauri::AppHandle) -> Result<Self, String> {
        let (exe, config, cache, key) = tauri::async_runtime::spawn_blocking(move || {
            let exe = executable(&app)?;
            let root = checked_folder(&app.path().app_data_dir().map_err(|_| "Couldn't locate Comet's local data.")?, "rclone")?;
            let cache = checked_folder(&app.path().app_cache_dir().map_err(|_| "Couldn't locate Comet's cloud cache.")?, "rclone")?;
            let config = root.join("cloud.conf"); let key = config_key(&config)?;
            Ok::<_, String>((exe, config, cache, key))
        }).await.map_err(|_| "Couldn't prepare the cloud connection.")??;
        let http = Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(120)).build().map_err(|_| "Couldn't initialize the cloud connection.")?;
        let launch_key = key.clone();
        let (child, job, origin, password) = tauri::async_runtime::spawn_blocking(move || launch(&exe, &config, &cache, &launch_key))
            .await.map_err(|_| "Couldn't start bundled rclone.")??;
        let engine = Self { child, _job: job, origin, password, http };
        // This is essential on first run: RCLONE_CONFIG_PASS alone unlocks an
        // existing config but does not encrypt the very first config save.
        engine.call("config/unlock", json!({"configPassword": key})).await?;
        Ok(engine)
    }
    #[cfg(test)]
    pub async fn for_test(exe: PathBuf, root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root).map_err(|_| "Couldn't create a cloud test folder.")?;
        let config = root.join("test.conf"); let cache = root.join("cache"); fs::create_dir_all(&cache).map_err(|_| "Couldn't create a cloud test cache.")?;
        let key = "not-a-real-credential-used-only-for-tests".to_string(); let launch_key = key.clone();
        let (child, job, origin, password) = tauri::async_runtime::spawn_blocking(move || launch(&exe, &config, &cache, &launch_key)).await.map_err(|_| "Test cloud process failed.")??;
        let http = Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(30)).build().map_err(|_| "Test client failed.")?;
        let engine = Self { child, _job: job, origin, password, http };
        engine.call("config/unlock", json!({"configPassword":key})).await?;
        Ok(engine)
    }
    pub async fn call(&self, path: &str, input: Value) -> Result<Value, String> {
        self.call_optional(path, input).await?.ok_or_else(|| ERROR.into())
    }
    pub async fn call_optional(&self, path: &str, input: Value) -> Result<Option<Value>, String> {
        let mut response = self.http.post(format!("{}/{}", self.origin, path)).basic_auth(RC_USER, Some(&self.password)).json(&input).send().await.map_err(|_| ERROR)?;
        if response.status() == StatusCode::NOT_FOUND { return Ok(None); }
        if !response.status().is_success() { return Err(ERROR.into()); }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ERROR)? {
            if bytes.len().saturating_add(chunk.len()) > 16 * 1024 * 1024 { return Err("Cloud returned too much metadata; no local files were changed.".into()); }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map(Some).map_err(|_| "Cloud returned invalid metadata; no local files were changed.".into())
    }
    pub async fn list(&self, remote: &str, path: &str) -> Result<Vec<Value>, String> {
        let result = self.call_optional("operations/list", json!({"fs":format!("{remote}:"),"remote":path,"opt":{"noMimeType":true}})).await?;
        match result { None => Ok(Vec::new()), Some(v) => v.get("list").and_then(Value::as_array).cloned().ok_or_else(|| "Cloud returned an invalid directory listing.".into()) }
    }
    pub async fn mkdir(&self, remote: &str, path: &str) -> Result<(), String> {
        self.call("operations/mkdir", json!({"fs":format!("{remote}:"),"remote":path})).await.map(|_| ())
    }
    pub async fn read(&self, remote: &str, path: &str, limit: usize) -> Result<Vec<u8>, String> {
        let mut response = self.http.get(format!("{}/[{}:]/{}", self.origin, remote, path)).basic_auth(RC_USER, Some(&self.password)).send().await.map_err(|_| ERROR)?;
        if !response.status().is_success() || response.content_length().is_some_and(|n| n > limit as u64) { return Err("A cloud sync object is missing or too large. No local files were changed.".into()); }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ERROR)? {
            if bytes.len().checked_add(chunk.len()).is_none_or(|n| n > limit) { return Err("A cloud sync object is too large. No local files were changed.".into()); }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
    pub async fn upload(&self, remote: &str, dir: &str, name: &str, bytes: &[u8]) -> Result<(), String> {
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.')) { return Err("Invalid cloud object name.".into()); }
        let boundary = format!("comet{}", nonce()?);
        let mut body = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n").into_bytes();
        body.extend_from_slice(bytes); body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let fs = format!("{remote}:");
        let response = self.http.post(format!("{}/operations/uploadfile", self.origin)).basic_auth(RC_USER, Some(&self.password))
            .query(&[("fs", fs.as_str()), ("remote", dir)]).header("Content-Type", format!("multipart/form-data; boundary={boundary}")).body(body).send().await.map_err(|_| ERROR)?;
        if !response.status().is_success() { return Err(ERROR.into()); }
        Ok(())
    }
}

fn launch(exe: &Path, config: &Path, cache: &Path, key: &str) -> Result<(Child, ParentJob, String, String), String> {
    let password = nonce()?;
    let mut command = Command::new(exe);
    command.args(["rcd", "--rc-addr=127.0.0.1:0", "--rc-serve", "--ask-password=false", "--contimeout=15s", "--timeout=90s", "--retries=1", "--low-level-retries=2"])
        .arg("--config").arg(config).arg("--cache-dir").arg(cache)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    for (name, _) in std::env::vars_os() { if name.to_string_lossy().starts_with("RCLONE_") || name == "_RCLONE_CONFIG_KEY_FILE" { command.env_remove(name); } }
    command.env("RCLONE_RC_USER", RC_USER).env("RCLONE_RC_PASS", &password).env("RCLONE_CONFIG_PASS", key);
    #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    #[cfg(target_os = "linux")] {
        use std::os::unix::process::CommandExt;
        let parent = std::process::id();
        // A sudden Comet crash should not leave the powerful RC endpoint alive.
        unsafe { command.pre_exec(move || {
            unsafe extern "C" { fn prctl(option: i32, ...) -> i32; fn getppid() -> i32; }
            if prctl(1, 9, 0, 0, 0) != 0 || getppid() as u32 != parent { return Err(std::io::Error::other("could not attach cloud process to parent")); }
            Ok(())
        }); }
    }
    let mut child = command.spawn().map_err(|_| "Couldn't start bundled rclone.")?;
    let job = match ParentJob::attach(&child) { Ok(job) => job, Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(error); } };
    let stderr = match child.stderr.take() { Some(stderr) => stderr, None => { let _ = child.kill(); let _ = child.wait(); return Err("Couldn't start the local cloud connection.".into()); } };
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr); let mut line = String::new();
        let _ = reader.read_line(&mut line); let _ = tx.send(line);
        // Consume, but never log, provider output: it can contain secrets.
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
    });
    let line = match rx.recv_timeout(Duration::from_secs(15)) { Ok(line) => line, Err(_) => { let _ = child.kill(); let _ = child.wait(); return Err("The local cloud connection did not start.".into()); } };
    let origin = line.split_once("Serving remote control on ").map(|(_, s)| s.trim().trim_end_matches('/').to_string()).ok_or_else(|| { let _ = child.kill(); let _ = child.wait(); "The local cloud connection did not start.".to_string() })?;
    let url = match url::Url::parse(&origin) { Ok(url) => url, Err(_) => { let _ = child.kill(); let _ = child.wait(); return Err("Invalid local cloud endpoint.".into()); } };
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none() { let _ = child.kill(); let _ = child.wait(); return Err("Invalid local cloud endpoint.".into()); }
    Ok((child, job, origin, password))
}

// On Windows, close the job handle when Comet exits, even on a crash. Windows
// then terminates its children; a leftover authenticated RC server cannot linger.
#[cfg(windows)]
struct ParentJob(usize);
#[cfg(not(windows))]
struct ParentJob;
#[cfg(not(windows))]
impl ParentJob { fn attach(_: &Child) -> Result<Self, String> { Ok(Self) } }
#[cfg(windows)]
impl ParentJob {
    fn attach(child: &Child) -> Result<Self, String> {
        use std::{ffi::c_void, os::windows::io::AsRawHandle};
        type Handle = *mut c_void;
        #[repr(C)]
        struct Basic { process_time: i64, job_time: i64, flags: u32, min_working: usize, max_working: usize, active_limit: u32, affinity: usize, priority: u32, scheduling: u32 }
        #[repr(C)]
        struct Io { read_ops: u64, write_ops: u64, other_ops: u64, read_bytes: u64, write_bytes: u64, other_bytes: u64 }
        #[repr(C)]
        struct Extended { basic: Basic, io: Io, process_memory: usize, job_memory: usize, peak_process_memory: usize, peak_job_memory: usize }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> Handle;
            fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, size: u32) -> i32;
            fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
            fn CloseHandle(handle: Handle) -> i32;
        }
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() { return Err("Couldn't safely start the cloud process.".into()); }
            let mut info: Extended = std::mem::zeroed();
            info.basic.flags = 0x0000_2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if SetInformationJobObject(handle, 9, &info as *const _ as *const c_void, std::mem::size_of::<Extended>() as u32) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle() as Handle) == 0 {
                CloseHandle(handle); return Err("Couldn't safely attach the cloud process to Comet.".into());
            }
            Ok(Self(handle as usize))
        }
    }
}
#[cfg(windows)]
impl Drop for ParentJob {
    fn drop(&mut self) {
        #[link(name = "kernel32")]
        unsafe extern "system" { fn CloseHandle(handle: *mut std::ffi::c_void) -> i32; }
        unsafe { CloseHandle(self.0 as *mut std::ffi::c_void); }
    }
}
