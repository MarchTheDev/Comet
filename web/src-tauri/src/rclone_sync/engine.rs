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
const CONFIG_SERVICE: &str = "com.comet.rclone";
const CONFIG_ACCOUNT: &str = "encrypted-config-key";
const RC_USER: &str = "comet";
const ERROR: &str = "Cloud connection failed. Check your connection or reconnect the provider; local files are safe and will be retried.";

pub(super) async fn pause(milliseconds: u64) { let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_millis(milliseconds))).await; }
fn retryable(status: StatusCode, body: &str) -> bool {
    let lower = body.to_ascii_lowercase();
    status == StatusCode::TOO_MANY_REQUESTS
        || status == StatusCode::SERVICE_UNAVAILABLE
        || status == StatusCode::BAD_GATEWAY
        || status == StatusCode::GATEWAY_TIMEOUT
        || ["rate limit", "ratelimit", "userratelimitexceeded", "quota", "backend error", "try again", "internal server error"].iter().any(|pattern| lower.contains(pattern))
}
fn transport_failure(error: reqwest::Error) -> String {
    if error.is_timeout() { "The cloud request timed out. Comet will retry; local files are safe.".into() }
    else if error.is_connect() { "Couldn't reach the cloud provider. Check your connection; Comet will retry; local files are safe.".into() }
    else { ERROR.into() }
}
/// Turn a provider failure into one actionable sentence. This deliberately
/// classifies rather than echoing the raw response, which can include account
/// details or internal paths.
fn cloud_failure(status: StatusCode, body: &str) -> String {
    let lower = body.to_ascii_lowercase();
    let has = |patterns: &[&str]| patterns.iter().any(|pattern| lower.contains(pattern));
    let code = status.as_u16();
    if code == 401 || has(&["invalid_grant", "invalid credentials", "token expired", "expired or revoked", "unauthorized", "token has been expired"]) {
        return "The provider rejected or expired the saved sign-in. Reconnect Google Drive or iCloud Drive in Settings → Cloud; local files are safe and will be retried.".into();
    }
    if code == 429 || has(&["rate limit", "ratelimit", "quota", "userratelimitexceeded"]) {
        return "The provider temporarily refused the request (rate limit or quota). Comet will retry; local files are safe.".into();
    }
    if code == 404 || has(&["not found", "directory not found", "object not found"]) {
        return "The cloud folder or file was not found. It may have been moved or deleted; local files are safe and will be retried.".into();
    }
    if code == 408 || has(&["timeout", "deadline exceeded"]) {
        return "The cloud request timed out. Comet will retry; local files are safe.".into();
    }
    if has(&["no such host", "connection refused", "network is unreachable", "tls handshake", "dial tcp", "proxyconnect", "server misbehaving"]) {
        return "Couldn't reach the cloud provider. Check your connection; Comet will retry; local files are safe.".into();
    }
    if has(&["config password", "config unlock", "decrypt"]) {
        return "Comet couldn't unlock the saved cloud sign-in. Reconnect the provider in Settings → Cloud; local files are safe.".into();
    }
    if code == 403 { return "The provider refused this request (HTTP 403). Reconnect the provider in Settings → Cloud if it keeps happening; local files are safe and will be retried.".into(); }
    format!("The cloud provider returned HTTP {code}. Comet will retry; local files are safe. If this keeps happening, reconnect the provider in Settings → Cloud.")
}
fn nonce() -> Result<String, String> {
    let mut bytes = [0u8; 32]; getrandom::fill(&mut bytes).map_err(|_| "Couldn't create secure cloud connection data.")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
pub(super) fn checked_folder(base: &Path, name: &str) -> Result<PathBuf, String> {
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

pub struct Engine { child: Child, _job: ParentJob, origin: String, password: String, http: Client, cache_root: PathBuf }
impl Drop for Engine {
    fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); }
}
impl Engine {
    pub async fn start(app: tauri::AppHandle) -> Result<Self, String> {
        let (exe, config, cache, key, cache_root) = tauri::async_runtime::spawn_blocking(move || {
            let exe = executable(&app)?;
            let cache_root = app.path().app_cache_dir().map_err(|_| "Couldn't locate Comet's cloud cache.")?;
            let root = checked_folder(&app.path().app_data_dir().map_err(|_| "Couldn't locate Comet's local data.")?, "rclone")?;
            let cache = checked_folder(&cache_root, "rclone")?;
            let config = root.join("cloud.conf"); let key = config_key(&config)?;
            Ok::<_, String>((exe, config, cache, key, cache_root))
        }).await.map_err(|_| "Couldn't prepare the cloud connection.")??;
        let http = Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(120)).build().map_err(|_| "Couldn't initialize the cloud connection.")?;
        let launch_key = key.clone();
        let (child, job, origin, password) = tauri::async_runtime::spawn_blocking(move || launch(&exe, &config, &cache, &launch_key))
            .await.map_err(|_| "Couldn't start bundled rclone.")??;
        let engine = Self { child, _job: job, origin, password, http, cache_root };
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
        let engine = Self { child, _job: job, origin, password, http, cache_root: root };
        engine.call("config/unlock", json!({"configPassword":key})).await?;
        Ok(engine)
    }
    /// The local cache base shared by small, non-secret sync indexes.
    pub fn cache_root(&self) -> &Path { &self.cache_root }
    #[cfg(test)]
    pub fn stop_for_test(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
    pub async fn call(&self, path: &str, input: Value) -> Result<Value, String> {
        self.call_optional(path, input).await?.ok_or_else(|| "A required cloud item is missing. Comet will retry; local files are safe.".into())
    }
    pub async fn call_for(&self, path: &str, input: Value, timeout: Duration) -> Result<Value, String> {
        self.call_optional_for(path, input, timeout).await?.ok_or_else(|| "A required cloud item is missing. Comet will retry; local files are safe.".to_string())
    }
    pub async fn call_optional(&self, path: &str, input: Value) -> Result<Option<Value>, String> {
        self.call_optional_for(path, input, Duration::from_secs(120)).await
    }
    async fn call_optional_for(&self, path: &str, input: Value, timeout: Duration) -> Result<Option<Value>, String> {
        let mut delay = 2_000u64;
        for attempt in 0..3 {
            let mut response = self.http.post(format!("{}/{}", self.origin, path)).basic_auth(RC_USER, Some(&self.password)).timeout(timeout).json(&input).send().await.map_err(transport_failure)?;
            if response.status() == StatusCode::NOT_FOUND { return Ok(None); }
            if !response.status().is_success() {
                let status = response.status();
                // rclone puts the provider's reason in the JSON body. Keep it
                // only long enough to classify it; never show raw text that
                // could contain credentials or internal paths.
                let mut body = Vec::new();
                while body.len() < 8 * 1024 {
                    match response.chunk().await {
                        Ok(Some(chunk)) => body.extend_from_slice(&chunk),
                        _ => break,
                    }
                }
                let reason = String::from_utf8_lossy(&body).to_string();
                // Provider throttling is expected during large first syncs.
                // Wait inside the connection instead of failing the whole pass
                // and making the user wait for the next scheduled attempt.
                if attempt < 2 && retryable(status, &reason) {
                    pause(delay).await; delay *= 3; continue;
                }
                return Err(cloud_failure(status, &reason));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(transport_failure)? {
                if bytes.len().saturating_add(chunk.len()) > 16 * 1024 * 1024 { return Err("Cloud returned too much metadata; no local files were changed.".into()); }
                bytes.extend_from_slice(&chunk);
            }
            return serde_json::from_slice(&bytes).map(Some).map_err(|_| "Cloud returned invalid metadata; no local files were changed.".into());
        }
        Err(cloud_failure(StatusCode::TOO_MANY_REQUESTS, "rate limit"))
    }
    /// Resolve rclone's one-time loopback redirect ourselves so only the
    /// provider page is opened in the browser. Never follow external redirects.
    pub async fn google_authorization_page(&self, address: &str) -> Result<String, String> {
        let local = url::Url::parse(address).map_err(|_| "Invalid local Google sign-in address.")?;
        if local.scheme() != "http" || local.host_str() != Some("127.0.0.1") || local.port() != Some(53682)
            || local.path() != "/auth" || !local.username().is_empty() || local.password().is_some() || local.fragment().is_some() {
            return Err("Invalid local Google sign-in address.".into());
        }
        let states: Vec<_> = local.query_pairs().filter(|(key, _)| key == "state").map(|(_, value)| value.into_owned()).collect();
        if states.len() != 1 || states[0].is_empty() || states[0].len() > 500 { return Err("Invalid local Google sign-in state.".into()); }
        let response = self.http.get(local).timeout(Duration::from_secs(5)).send().await.map_err(|_| "Couldn't start the Google sign-in page.")?;
        if !response.status().is_redirection() { return Err("Couldn't start the Google sign-in page.".into()); }
        let location = response.headers().get(reqwest::header::LOCATION).and_then(|value| value.to_str().ok()).ok_or("Invalid Google sign-in response.")?;
        let mut google = url::Url::parse(location).map_err(|_| "Invalid Google sign-in response.")?;
        if google.scheme() != "https" || google.host_str() != Some("accounts.google.com") || google.port_or_known_default() != Some(443)
            || !google.username().is_empty() || google.password().is_some() || google.fragment().is_some() {
            return Err("Invalid Google sign-in destination.".into());
        }
        let values = |name: &str| google.query_pairs().filter(|(key, _)| key == name).map(|(_, value)| value.into_owned()).collect::<Vec<_>>();
        if values("state") != states || values("redirect_uri") != ["http://127.0.0.1:53682/"]
            || values("response_type") != ["code"] || values("scope") != ["https://www.googleapis.com/auth/drive.file"]
            || values("client_id").len() != 1 {
            return Err("Invalid Google sign-in parameters.".into());
        }
        // Google may omit a refresh token on repeat grants unless consent is
        // requested again. Never borrow a previous account's token instead.
        if values("prompt").is_empty() { google.query_pairs_mut().append_pair("prompt", "consent"); }
        else if values("prompt") != ["consent"] { return Err("Invalid Google sign-in parameters.".into()); }
        Ok(google.to_string())
    }
    pub async fn list(&self, remote: &str, path: &str) -> Result<Vec<Value>, String> {
        let result = self.call_optional("operations/list", json!({"fs":format!("{remote}:"),"remote":path,"opt":{"noMimeType":true}})).await?;
        match result { None => Ok(Vec::new()), Some(v) => v.get("list").and_then(Value::as_array).cloned().ok_or_else(|| "Cloud returned an invalid directory listing.".into()) }
    }
    pub async fn mkdir(&self, remote: &str, path: &str) -> Result<(), String> {
        self.call("operations/mkdir", json!({"fs":format!("{remote}:"),"remote":path})).await.map(|_| ())
    }
    pub async fn read(&self, remote: &str, path: &str, limit: usize) -> Result<Vec<u8>, String> {
        // Each path component must be URL-encoded: user filenames can contain
        // spaces, #, %, question marks on some platforms, or non-ASCII text.
        let mut url = url::Url::parse(&format!("{}/", self.origin)).map_err(|_| "Invalid local cloud endpoint.")?;
        {
            let mut segments = url.path_segments_mut().map_err(|_| "Invalid local cloud endpoint.")?;
            segments.pop_if_empty().push(&format!("[{remote}:]"));
            for component in path.split('/') { segments.push(component); }
        }
        let mut delay = 2_000u64;
        for attempt in 0..3 {
            let mut response = self.http.get(url.clone()).basic_auth(RC_USER, Some(&self.password)).send().await.map_err(transport_failure)?;
            let status = response.status();
            if status.is_success() {
                if response.content_length().is_some_and(|n| n > limit as u64) { return Err("A cloud sync object is too large. No local files were changed.".into()); }
                let mut bytes = Vec::new();
                while let Some(chunk) = response.chunk().await.map_err(transport_failure)? {
                    if bytes.len().checked_add(chunk.len()).is_none_or(|n| n > limit) { return Err("A cloud sync object is too large. No local files were changed.".into()); }
                    bytes.extend_from_slice(&chunk);
                }
                return Ok(bytes);
            }
            let mut body = Vec::new();
            while body.len() < 4 * 1024 {
                match response.chunk().await {
                    Ok(Some(chunk)) => body.extend_from_slice(&chunk),
                    _ => break,
                }
            }
            let reason = String::from_utf8_lossy(&body).to_string();
            if attempt < 2 && retryable(status, &reason) { pause(delay).await; delay *= 3; continue; }
            return Err(cloud_failure(status, &reason));
        }
        Err(cloud_failure(StatusCode::TOO_MANY_REQUESTS, "rate limit"))
    }
    /// Copy a verified immutable object to a uniquely named readable snapshot.
    /// Callers choose a fresh random destination; this is never used to replace
    /// a user-editable cloud file or mutate the authoritative revision history.
    pub async fn copy(&self, remote: &str, source: &str, destination: &str, limit: usize) -> Result<(), String> {
        let fs = format!("{remote}:");
        if self.call("operations/copyfile", json!({"srcFs":fs.as_str(),"srcRemote":source,"dstFs":fs.as_str(),"dstRemote":destination})).await.is_ok() { return Ok(()); }
        // Not every provider can copy on the server. Fall back to a byte
        // transfer through a strict temporary name, then rename without a
        // multipart filename (readable names may contain any Unicode text).
        let bytes = self.read(remote, source, limit).await?;
        let (dir, _) = destination.rsplit_once('/').ok_or("Invalid cloud copy destination.")?;
        self.mkdir(remote, dir).await?;
        let temp = format!(".comet-copy-{}", nonce()?);
        self.upload(remote, dir, &temp, &bytes).await?;
        self.call("operations/movefile", json!({"fs":fs.as_str(),"srcRemote":format!("{dir}/{temp}"),"dstRemote":destination})).await.map(|_| ())
    }
    pub async fn upload(&self, remote: &str, dir: &str, name: &str, bytes: &[u8]) -> Result<(), String> {
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.')) { return Err("Invalid cloud object name.".into()); }
        let boundary = format!("comet{}", nonce()?);
        let mut body = format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n").into_bytes();
        body.extend_from_slice(bytes); body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let fs = format!("{remote}:");
        let response = self.http.post(format!("{}/operations/uploadfile", self.origin)).basic_auth(RC_USER, Some(&self.password))
            .query(&[("fs", fs.as_str()), ("remote", dir)]).header("Content-Type", format!("multipart/form-data; boundary={boundary}")).body(body).send().await.map_err(transport_failure)?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            let short: String = body.chars().take(4096).collect();
            return Err(cloud_failure(status, &short));
        }
        Ok(())
    }
}

fn launch(exe: &Path, config: &Path, cache: &Path, key: &str) -> Result<(Child, ParentJob, String, String), String> {
    let password = nonce()?;
    let mut command = Command::new(exe);
    command.args(["rcd", "--rc-addr=127.0.0.1:0", "--rc-serve", "--ask-password=false", "--contimeout=15s", "--timeout=90s", "--retries=1", "--low-level-retries=2"])
        .arg("--config").arg(config).arg("--cache-dir").arg(cache)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::piped());
    for (name, _) in std::env::vars_os() { if name.to_string_lossy().to_ascii_uppercase().starts_with("RCLONE_") || name.to_string_lossy().eq_ignore_ascii_case("_RCLONE_CONFIG_KEY_FILE") { command.env_remove(name); } }
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_failures_are_actionable_and_do_not_echo_the_response() {
        let auth = cloud_failure(StatusCode::UNAUTHORIZED, r#"{"error":"oauth2: \"invalid_grant\" token expired for user 123"}"#);
        assert!(auth.contains("Reconnect Google Drive") && !auth.contains("invalid_grant") && !auth.contains("user 123"));
        assert!(cloud_failure(StatusCode::FORBIDDEN, r#"{"error":"userRateLimitExceeded"}"#).contains("rate limit or quota"));
        assert!(cloud_failure(StatusCode::INTERNAL_SERVER_ERROR, r#"{"error":"directory not found"}"#).contains("not found"));
        assert!(cloud_failure(StatusCode::BAD_GATEWAY, "<html>secret-token</html>").contains("HTTP 502"));
        assert!(!cloud_failure(StatusCode::BAD_GATEWAY, "<html>secret-token</html>").contains("secret-token"));
    }
    #[test]
    fn provider_throttling_is_retried_but_real_failures_are_not() {
        assert!(retryable(StatusCode::TOO_MANY_REQUESTS, ""));
        assert!(retryable(StatusCode::FORBIDDEN, r#"{"error":"userRateLimitExceeded"}"#));
        assert!(retryable(StatusCode::SERVICE_UNAVAILABLE, "try again"));
        assert!(!retryable(StatusCode::UNAUTHORIZED, r#"{"error":"invalid_grant"}"#));
        assert!(!retryable(StatusCode::NOT_FOUND, "not found"));
    }
}
