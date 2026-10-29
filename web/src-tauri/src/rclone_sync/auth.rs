//! Provider authorization stays in an encrypted rclone configuration; its key
//! lives in the operating system credential store, never in the workspace.
use super::engine::Engine;
use crate::google::{ConnectingGuard, SYNCING};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::time::{Duration, Instant};
use tauri_plugin_opener::OpenerExt;

const GOOGLE_SHARED: &str = "comet-rclone-google";
const GOOGLE_PENDING: &str = "comet-google-auth";
const GOOGLE_CANCELLED: &str = "Google sign-in was cancelled. Your existing cloud connections were not changed.";
struct GoogleAttempt { id: String, cancelled: AtomicBool, engine: Mutex<Option<Arc<Engine>>> }
struct GoogleAuthState { active: Option<Arc<GoogleAttempt>>, cancelled: Option<String> }
static GOOGLE_AUTH: Mutex<GoogleAuthState> = Mutex::new(GoogleAuthState { active: None, cancelled: None });
fn valid_attempt_id(id: &str) -> bool { (1..=80).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') }
fn register_google_attempt(id: String) -> Result<Arc<GoogleAttempt>, String> {
    let mut slot = GOOGLE_AUTH.lock().map_err(|_| "Google sign-in state is unavailable.")?;
    let cancelled = slot.cancelled.take().as_deref() == Some(id.as_str());
    let attempt = Arc::new(GoogleAttempt { id, cancelled: AtomicBool::new(cancelled), engine: Mutex::new(None) });
    slot.active = Some(attempt.clone());
    Ok(attempt)
}
struct ActiveGoogle(Arc<GoogleAttempt>);
impl Drop for ActiveGoogle {
    fn drop(&mut self) {
        if let Ok(mut slot) = GOOGLE_AUTH.lock() {
            if slot.active.as_ref().is_some_and(|current| Arc::ptr_eq(current, &self.0)) { slot.active = None; }
            if slot.cancelled.as_deref() == Some(self.0.id.as_str()) { slot.cancelled = None; }
        }
    }
}

struct Pending { remote: String, state: String, identity: String }
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account { remote: String, provider: String, identity: String, label: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Choice { value: String, label: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStep { complete: bool, remote: String, identity: String, prompt: String, choices: Vec<Choice> }

fn lock_cloud() -> Result<ConnectingGuard, String> {
    if SYNCING.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire).is_err() { return Err("A workspace sync or cloud sign-in is already running. Try again when it finishes.".into()); }
    Ok(ConnectingGuard(&SYNCING))
}
pub(crate) fn remote_ok(remote: &str) -> bool {
    matches!(remote, "comet-google" | GOOGLE_SHARED) || remote.strip_prefix("comet-icloud-").is_some_and(|id| id.len() == 32 && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
}
fn identity(apple_id: &str) -> String { super::hash(apple_id.trim().to_lowercase().as_bytes()) }
fn state(result: &Value) -> Result<&str, String> {
    if result.get("Error").and_then(Value::as_str).is_some_and(|message| !message.is_empty()) { return Err("The provider could not complete sign-in. Check the verification response and try again.".into()); }
    result.get("State").and_then(Value::as_str).ok_or_else(|| "The provider returned an invalid sign-in response.".into())
}
fn prompt(remote: &str, account_identity: &str, result: &Value) -> Result<AuthStep, String> {
    let next = state(result)?;
    if next.is_empty() { return Ok(AuthStep { complete: true, remote: remote.into(), identity: account_identity.into(), prompt: String::new(), choices: Vec::new() }); }
    if next.len() > 400 { return Err("The provider returned an invalid sign-in response.".into()); }
    let option = result.get("Option").and_then(Value::as_object).ok_or("The provider returned an invalid verification prompt.")?;
    let name = option.get("Name").and_then(Value::as_str).unwrap_or("");
    if !matches!(name, "config_2fa" | "config_2fa_sms" | "config_2fa_phone") { return Err("This iCloud verification step is not supported. No workspace files were changed.".into()); }
    let text = option.get("Help").and_then(Value::as_str).unwrap_or("Enter your verification code.").chars().filter(|c| !c.is_control() || *c == '\n').take(500).collect();
    let choices = option.get("Examples").and_then(Value::as_array).into_iter().flatten().filter_map(|item| {
        let value = item.get("Value")?.as_str()?; let label = item.get("Help")?.as_str()?;
        if value.len() > 100 || label.len() > 200 || value.chars().any(char::is_control) { return None; }
        Some(Choice { value: value.into(), label: label.into() })
    }).take(20).collect();
    Ok(AuthStep { complete: false, remote: remote.into(), identity: account_identity.into(), prompt: text, choices })
}
async fn verified_icloud(engine: &Engine, remote: &str) -> Result<(), String> {
    let data = engine.call("config/get", json!({"name":remote})).await?;
    if data.get("type").and_then(Value::as_str) != Some("iclouddrive") || data.get("trust_token").and_then(Value::as_str).is_none_or(str::is_empty) {
        return Err("iCloud did not return a trusted session. Reconnect and complete two-factor authentication.".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn rclone_icloud_begin(app: tauri::AppHandle, apple_id: String, password: String) -> Result<AuthStep, String> {
    if apple_id.trim().is_empty() || apple_id.len() > 320 || password.is_empty() || password.len() > 1000 || apple_id.chars().any(char::is_control) || password.chars().any(char::is_control) {
        return Err("Enter your Apple ID and regular Apple ID password.".into());
    }
    let _guard = lock_cloud()?;
    let engine = Engine::start(app).await?;
    let old = PENDING.lock().map_err(|_| "Cloud sign-in state is unavailable.")?.take();
    if let Some(old) = old { let _ = engine.call("config/delete", json!({"name":old.remote})).await; }
    let remote = format!("comet-icloud-{}", super::new_id()?);
    let account_identity = identity(&apple_id);
    let result = engine.call("config/create", json!({"name":remote,"type":"iclouddrive","parameters":{"service":"drive","apple_id":apple_id.trim(),"password":password},"opt":{"nonInteractive":true,"obscure":true}})).await;
    let step = match result.and_then(|result| prompt(&remote, &account_identity, &result).map(|step| (step, result))) {
        Ok(value) => value,
        Err(error) => { let _ = engine.call("config/delete", json!({"name":remote})).await; return Err(error); }
    };
    if step.0.complete {
        if let Err(error) = verified_icloud(&engine, &remote).await { let _ = engine.call("config/delete", json!({"name":remote})).await; return Err(error); }
    } else { *PENDING.lock().map_err(|_| "Cloud sign-in state is unavailable.")? = Some(Pending { remote: remote.clone(), state: state(&step.1)?.into(), identity: account_identity }); }
    Ok(step.0)
}
#[tauri::command]
pub async fn rclone_icloud_continue(app: tauri::AppHandle, answer: String) -> Result<AuthStep, String> {
    if answer.trim().is_empty() || answer.len() > 200 || answer.chars().any(char::is_control) { return Err("Enter the verification code or select a trusted phone.".into()); }
    let _guard = lock_cloud()?;
    let pending = PENDING.lock().map_err(|_| "Cloud sign-in state is unavailable.")?.take().ok_or("Start iCloud sign-in again.")?;
    let operation = async {
        let engine = Engine::start(app).await?;
        let result = engine.call("config/update", json!({"name":&pending.remote,"parameters":{},"opt":{"continue":true,"nonInteractive":true,"state":&pending.state,"result":answer.trim()}})).await?;
        let step = prompt(&pending.remote, &pending.identity, &result)?;
        if step.complete { verified_icloud(&engine, &pending.remote).await?; }
        Ok::<_, String>((step, state(&result)?.to_string()))
    }.await;
    match operation {
        Ok((step, next)) => {
            if !step.complete { *PENDING.lock().map_err(|_| "Cloud sign-in state is unavailable.")? = Some(Pending { state: next, ..pending }); }
            Ok(step)
        },
        Err(error) => { *PENDING.lock().map_err(|_| "Cloud sign-in state is unavailable.")? = Some(pending); Err(error) }
    }
}
#[tauri::command]
pub async fn rclone_icloud_cancel(app: tauri::AppHandle) -> Result<(), String> {
    let _guard = lock_cloud()?;
    let pending = PENDING.lock().map_err(|_| "Cloud sign-in state is unavailable.")?.take();
    if let Some(pending) = pending { Engine::start(app).await?.call("config/delete", json!({"name":pending.remote})).await?; }
    Ok(())
}
// Start the same built-in rclone Google OAuth flow as Orbit, without exposing
// the powerful RC API, a token, or an OAuth client field to the renderer.
async fn browser_step<F>(engine: Arc<Engine>, current: String, attempt: &Arc<GoogleAttempt>, open: &F) -> Result<Value, String>
where F: Fn(&str) -> Result<(), String> + Send + Sync {
    let worker = engine.clone();
    let task = tauri::async_runtime::spawn(async move {
        worker.call_for("config/update", json!({"name":GOOGLE_PENDING,"parameters":{"config_auth_no_browser":"true"},"opt":{"continue":true,"nonInteractive":true,"state":current,"result":"true"}}), Duration::from_secs(305)).await
    });
    let started = Instant::now(); let mut opened = false;
    let failure = loop {
        if attempt.cancelled.load(Ordering::Acquire) { break GOOGLE_CANCELLED.to_string(); }
        if task.inner().is_finished() {
            return task.await.map_err(|_| "Google sign-in was interrupted.".to_string())?
                .map_err(|_| "Google sign-in could not finish. Check the browser and connection, then try again; the shared rclone client may also no longer be accepted.".to_string());
        }
        if !opened {
            if started.elapsed() > Duration::from_secs(15) { break "Google sign-in couldn't start. Another app may be using its local sign-in port (53682).".into(); }
            let status = engine.call_for("config/oauthstatus", json!({}), Duration::from_secs(3)).await;
            match status {
                Ok(value) if value.get("status").and_then(Value::as_str) == Some("running") => {
                    let address = value.get("authUrl").and_then(Value::as_str).unwrap_or("");
                    match engine.google_authorization_page(address).await {
                        Ok(page) if !attempt.cancelled.load(Ordering::Acquire) => match open(&page) {
                            Ok(()) => opened = true,
                            Err(error) => break error,
                        },
                        Ok(_) => break GOOGLE_CANCELLED.into(),
                        Err(error) => break error,
                    }
                },
                Ok(_) => {},
                Err(_) => break "Couldn't start the local Google sign-in. Try again.".into(),
            }
        }
        if started.elapsed() > Duration::from_secs(300) { break "Google sign-in timed out. Try connecting again.".into(); }
        let _ = tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(200))).await;
    };
    // Cancelling never leaves a listening OAuth server behind. The task owns a
    // clone of the engine, so abort it as well before its final owner is dropped.
    let _ = engine.call_for("config/oauthstop", json!({}), Duration::from_secs(2)).await;
    task.abort();
    Err(failure)
}
fn google_token(data: &Value) -> Result<String, String> {
    if data.get("type").and_then(Value::as_str) != Some("drive") || data.get("scope").and_then(Value::as_str) != Some("drive.file") {
        return Err("Google returned an invalid Drive connection. No existing connection was changed.".into());
    }
    let raw = data.get("token").and_then(Value::as_str).filter(|value| value.len() < 20_000).ok_or("Google did not return a Drive authorization.")?;
    let token: Value = serde_json::from_str(raw).map_err(|_| "Google returned invalid authorization data.")?;
    if ["access_token", "refresh_token"].iter().any(|name| token.get(*name).and_then(Value::as_str).is_none_or(str::is_empty)) {
        return Err("Google did not return a renewable sign-in. Try connecting and approving access again.".into());
    }
    Ok(raw.to_string())
}
fn stored_google_identity(data: &Value) -> Result<&str, String> {
    data.get("comet_identity").and_then(Value::as_str).filter(|id| id.len() == 64 && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
        .ok_or_else(|| "Google account identity is unavailable. Reconnect this account before syncing.".into())
}
fn identity_from_google_about(data: &Value) -> Result<String, String> {
    let id = data.get("user").and_then(|user| user.get("permissionId")).and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 256 && id.bytes().all(|c| c.is_ascii_graphic()))
        .ok_or("Google didn't identify this Drive account. No existing connection was changed.")?;
    Ok(super::hash(format!("comet-rclone-google:{id}").as_bytes()))
}
async fn google_identity(data: &Value) -> Result<String, String> {
    let raw = google_token(data)?;
    let token: Value = serde_json::from_str(&raw).map_err(|_| "Google returned invalid authorization data.")?;
    let access = token.get("access_token").and_then(Value::as_str).ok_or("Google did not return a Drive authorization.")?;
    let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(30)).build().map_err(|_| "Couldn't verify this Google account.")?;
    // Drive's about.get supports the same narrow drive.file scope. Never log
    // this response or the bearer token; only its account ID hash is retained.
    let mut response = client.get("https://www.googleapis.com/drive/v3/about").query(&[("fields", "user(permissionId)")]).bearer_auth(access).send().await
        .map_err(|_| "Couldn't verify this Google Drive account. Check the connection and try again.")?;
    if !response.status().is_success() { return Err("Couldn't verify this Google Drive account. No existing connection was changed.".into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Couldn't verify this Google account.")? {
        if bytes.len().saturating_add(chunk.len()) > 16_384 { return Err("Google returned an invalid account identity.".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let about: Value = serde_json::from_slice(&bytes).map_err(|_| "Google returned an invalid account identity.")?;
    identity_from_google_about(&about)
}
async fn install_google(engine: &Engine, data: &Value) -> Result<(), String> {
    stored_google_identity(data)?;
    let mut parameters = data.as_object().cloned().ok_or("Invalid Google connection.")?;
    parameters.remove("type");
    // These are wizard answers only; no user token is passed as an argument.
    parameters.insert("config_shared_client_id".into(), json!("true"));
    parameters.insert("config_refresh_token".into(), json!("false"));
    parameters.insert("config_change_team_drive".into(), json!("false"));
    let result = engine.call("config/create", json!({"name":GOOGLE_SHARED,"type":"drive","parameters":parameters,"opt":{"nonInteractive":true}})).await?;
    if !state(&result)?.is_empty() { return Err("Google returned an unexpected setup step. Your existing cloud history was not deleted.".into()); }
    let saved = engine.call("config/get", json!({"name":GOOGLE_SHARED})).await?;
    google_token(&saved)?;
    if stored_google_identity(&saved)? != stored_google_identity(data)? { return Err("Google account identity could not be saved.".into()); }
    Ok(())
}
async fn google_flow<F>(engine: Arc<Engine>, attempt: &Arc<GoogleAttempt>, open: &F) -> Result<Account, String>
where F: Fn(&str) -> Result<(), String> + Send + Sync {
    if attempt.cancelled.load(Ordering::Acquire) { return Err(GOOGLE_CANCELLED.into()); }
    let _ = engine.call("config/delete", json!({"name":GOOGLE_PENDING})).await;
    let mut result = engine.call("config/create", json!({"name":GOOGLE_PENDING,"type":"drive","parameters":{"scope":"drive.file","config_auth_no_browser":"true"},"opt":{"nonInteractive":true}})).await?;
    for _ in 0..8 {
        if attempt.cancelled.load(Ordering::Acquire) { return Err(GOOGLE_CANCELLED.into()); }
        let current = state(&result)?.to_string();
        if current.is_empty() {
            let data = engine.call("config/get", json!({"name":GOOGLE_PENDING})).await?;
            google_token(&data)?;
            // Verify the new account before replacing an existing shared-client
            // session. A missing Comet folder is normal; a failed request isn't.
            engine.list(GOOGLE_PENDING, super::ROOT).await.map_err(|_| "Google signed in, but Drive could not be reached. Your existing connection was not changed.".to_string())?;
            // rclone can refresh the access token during the verification above.
            let mut data = engine.call("config/get", json!({"name":GOOGLE_PENDING})).await?;
            let identity = google_identity(&data).await?;
            data["comet_identity"] = json!(identity.clone());
            if attempt.cancelled.load(Ordering::Acquire) { return Err(GOOGLE_CANCELLED.into()); }
            let previous = engine.call("config/get", json!({"name":GOOGLE_SHARED})).await?;
            let had_previous = previous.get("type").is_some();
            if had_previous { google_token(&previous)?; stored_google_identity(&previous)?; }
            let installed = install_google(&engine, &data).await;
            let cancelled = attempt.cancelled.load(Ordering::Acquire);
            if installed.is_err() || cancelled {
                let rollback = if had_previous { install_google(&engine, &previous).await }
                    else { engine.call("config/delete", json!({"name":GOOGLE_SHARED})).await.map(|_| ()) };
                if rollback.is_err() { return Err("Google sign-in could not restore the previous connection. Reconnect the previous account; no cloud files were deleted.".into()); }
                return Err(installed.err().unwrap_or_else(|| GOOGLE_CANCELLED.into()));
            }
            return Ok(Account { remote: GOOGLE_SHARED.into(), provider: "google".into(), identity, label: "Google Drive".into() });
        }
        let option = result.get("Option").and_then(|value| value.get("Name")).and_then(Value::as_str).unwrap_or("");
        match option {
            "config_shared_client_id" => result = engine.call("config/update", json!({"name":GOOGLE_PENDING,"parameters":{"config_auth_no_browser":"true"},"opt":{"continue":true,"nonInteractive":true,"state":current,"result":"true"}})).await?,
            "config_is_local" => result = browser_step(engine.clone(), current, attempt, open).await?,
            "config_change_team_drive" => result = engine.call("config/update", json!({"name":GOOGLE_PENDING,"parameters":{"config_auth_no_browser":"true"},"opt":{"continue":true,"nonInteractive":true,"state":current,"result":"false"}})).await?,
            _ => return Err("Google returned an unsupported sign-in step. No existing connection was changed.".into()),
        }
    }
    Err("Google returned too many sign-in steps. No existing connection was changed.".into())
}
#[tauri::command]
pub async fn rclone_connect_google(app: tauri::AppHandle, attempt_id: String) -> Result<Account, String> {
    if !valid_attempt_id(&attempt_id) { return Err("Invalid Google sign-in request.".into()); }
    let _guard = lock_cloud()?;
    let attempt = register_google_attempt(attempt_id)?;
    let _active = ActiveGoogle(attempt.clone());
    if attempt.cancelled.load(Ordering::Acquire) { return Err(GOOGLE_CANCELLED.into()); }
    let engine = Arc::new(Engine::start(app.clone()).await?);
    *attempt.engine.lock().map_err(|_| "Google sign-in state is unavailable.")? = Some(engine.clone());
    let result = google_flow(engine.clone(), &attempt, &|page| app.opener().open_url(page, None::<&str>).map_err(|_| "Couldn't open your browser for Google sign-in.".to_string())).await;
    let _ = engine.call("config/delete", json!({"name":GOOGLE_PENDING})).await;
    match result {
        Err(error) if attempt.cancelled.load(Ordering::Acquire) && !error.contains("could not restore the previous connection") => Err(GOOGLE_CANCELLED.into()),
        result => result,
    }
}
#[tauri::command]
pub async fn rclone_cancel_google(attempt_id: String) -> Result<(), String> {
    if !valid_attempt_id(&attempt_id) { return Err("Invalid Google sign-in request.".into()); }
    let attempt = {
        let mut slot = GOOGLE_AUTH.lock().map_err(|_| "Google sign-in state is unavailable.")?;
        let active = slot.active.as_ref().filter(|active| active.id == attempt_id).cloned();
        if active.is_none() { slot.cancelled = Some(attempt_id); }
        active
    };
    if let Some(attempt) = attempt {
        attempt.cancelled.store(true, Ordering::Release);
        let engine = attempt.engine.lock().map_err(|_| "Google sign-in state is unavailable.")?.clone();
        if let Some(engine) = engine { let _ = engine.call_for("config/oauthstop", json!({}), Duration::from_secs(2)).await; }
    }
    Ok(())
}
#[tauri::command]
pub async fn rclone_accounts(app: tauri::AppHandle) -> Result<Vec<Account>, String> {
    let _guard = lock_cloud()?; let engine = Engine::start(app).await?;
    let remotes = engine.call("config/listremotes", json!({})).await?;
    // A restart or abandoned sign-in must not retain an unfinished encrypted
    // password/session indefinitely. Never remove the currently active 2FA step.
    let pending_remote = PENDING.lock().map_err(|_| "Cloud sign-in state is unavailable.")?.as_ref().map(|pending| pending.remote.clone());
    let mut accounts = Vec::new();
    for name in remotes.get("remotes").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        if name == GOOGLE_PENDING { engine.call("config/delete", json!({"name":name})).await?; continue; }
        if !remote_ok(name) { continue; }
        let data = engine.call("config/get", json!({"name":name})).await?;
        if name == GOOGLE_SHARED && google_token(&data).is_ok() {
            if let Ok(identity) = stored_google_identity(&data) { accounts.push(Account { remote: name.into(), provider: "google".into(), identity: identity.into(), label: "Google Drive".into() }); }
        } else if name == "comet-google" && data.get("type").and_then(Value::as_str) == Some("drive") {
            accounts.push(Account { remote: name.into(), provider: "google".into(), identity: "google".into(), label: "Google Drive · earlier connection".into() });
        } else if name.starts_with("comet-icloud-") && data.get("type").and_then(Value::as_str) == Some("iclouddrive") && data.get("trust_token").and_then(Value::as_str).is_some_and(|v| !v.is_empty()) {
            if let Some(apple_id) = data.get("apple_id").and_then(Value::as_str) { accounts.push(Account { remote: name.into(), provider: "icloud".into(), identity: identity(apple_id), label: apple_id.into() }); }
        } else if name.starts_with("comet-icloud-") && pending_remote.as_deref() != Some(name) {
            engine.call("config/delete", json!({"name":name})).await?;
        }
    }
    Ok(accounts)
}
#[tauri::command]
pub async fn rclone_disconnect(app: tauri::AppHandle, remote: String) -> Result<(), String> {
    if !remote_ok(&remote) { return Err("Invalid cloud account.".into()); }
    let _guard = lock_cloud()?;
    Engine::start(app).await?.call("config/delete", json!({"name":remote})).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn google_shared_binding_is_distinct_from_earlier_connections() {
        assert!(remote_ok(GOOGLE_SHARED));
        assert!(remote_ok("comet-google"));
        assert!(!remote_ok(GOOGLE_PENDING));
        assert!(!remote_ok("comet-rclone-google/../../other"));
        let alice = identity_from_google_about(&json!({"user":{"permissionId":"alice-id"}})).unwrap();
        let bob = identity_from_google_about(&json!({"user":{"permissionId":"bob-id"}})).unwrap();
        assert_eq!(alice.len(), 64); assert_ne!(alice, bob);
        assert!(identity_from_google_about(&json!({"user":{}})).is_err());
        let token = json!({"access_token":"fake-access","refresh_token":"fake-refresh"}).to_string();
        assert!(google_token(&json!({"type":"drive","scope":"drive.file","token":token})).is_ok());
        assert!(google_token(&json!({"type":"drive","scope":"drive.file","token":"{}"})).is_err());
        assert!(google_token(&json!({"type":"drive","scope":"drive","token":"{}"})).is_err());
    }
    #[test]
    fn google_cancellation_before_start_is_scoped_to_its_attempt() {
        tauri::async_runtime::block_on(async {
            rclone_cancel_google("cancel-before-start".into()).await.unwrap();
            let attempt = register_google_attempt("cancel-before-start".into()).unwrap();
            let active = ActiveGoogle(attempt.clone());
            assert!(attempt.cancelled.load(Ordering::Acquire));
            drop(active);
            rclone_cancel_google("late-cancel".into()).await.unwrap();
            let other = register_google_attempt("new-attempt".into()).unwrap();
            let active = ActiveGoogle(other.clone());
            assert!(!other.cancelled.load(Ordering::Acquire));
            drop(active);
        });
    }
    #[test]
    fn local_rclone_google_opens_one_provider_page_and_cancels_without_replacing_credentials() {
        let Ok(exe) = std::env::var("COMET_RCLONE_TEST_BIN") else { return; };
        let root = std::env::temp_dir().join(format!("comet-google-auth-test-{}-{}", std::process::id(), super::super::new_id().unwrap()));
        std::fs::create_dir_all(&root).unwrap();
        tauri::async_runtime::block_on(async {
            let engine = Arc::new(Engine::for_test(exe.into(), root.clone()).await.unwrap());
            // Fake credentials never contact Google. They prove cancelling a
            // new sign-in cannot replace an existing encrypted connection.
            let old_token = json!({"access_token":"old-nonsecret-access","refresh_token":"old-nonsecret-refresh","expiry":"2035-01-01T00:00:00Z"}).to_string();
            let existing = json!({"type":"drive","scope":"drive.file","token":old_token,"comet_identity":"a".repeat(64)});
            install_google(&engine, &existing).await.unwrap();
            engine.call("config/create", json!({"name":"comet-google","type":"alias","parameters":{"remote":root.to_string_lossy()},"opt":{"nonInteractive":true}})).await.unwrap();
            let attempt = Arc::new(GoogleAttempt { id: "test-attempt".into(), cancelled: AtomicBool::new(false), engine: Mutex::new(Some(engine.clone())) });
            let opened = Arc::new(Mutex::new(Vec::<String>::new()));
            let seen = opened.clone(); let cancel = attempt.clone();
            let open = move |page: &str| -> Result<(), String> {
                seen.lock().unwrap().push(page.to_string());
                cancel.cancelled.store(true, Ordering::Release);
                Ok(())
            };
            let result = google_flow(engine.clone(), &attempt, &open).await;
            assert_eq!(result.unwrap_err(), GOOGLE_CANCELLED);
            let pages = opened.lock().unwrap().clone();
            assert_eq!(pages.len(), 1);
            let page = url::Url::parse(&pages[0]).unwrap();
            assert_eq!(page.scheme(), "https"); assert_eq!(page.host_str(), Some("accounts.google.com"));
            assert!(page.query_pairs().any(|(key, value)| key == "scope" && value == "https://www.googleapis.com/auth/drive.file"));
            assert!(page.query_pairs().any(|(key, value)| key == "prompt" && value == "consent"));
            assert!(engine.google_authorization_page("http://example.com/auth?state=fake").await.is_err());
            let after = engine.call("config/get", json!({"name":GOOGLE_SHARED})).await.unwrap();
            assert_eq!(google_token(&after).unwrap(), existing["token"].as_str().unwrap());
            assert_eq!(engine.call("config/get", json!({"name":"comet-google"})).await.unwrap()["type"], "alias");
            let config = std::fs::read_to_string(root.join("test.conf")).unwrap();
            assert!(config.contains("RCLONE_ENCRYPT_V0:")); assert!(!config.contains("old-nonsecret-refresh"));
            let _ = engine.call("config/delete", json!({"name":GOOGLE_PENDING})).await;
            drop(attempt); drop(engine);
        });
        let _ = std::fs::remove_dir_all(root);
    }
}
