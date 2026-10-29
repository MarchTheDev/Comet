//! Provider authorization stays in an encrypted rclone configuration; its key
//! lives in the operating system credential store, never in the workspace.
use super::engine::Engine;
use crate::google::{self, ConnectingGuard, SYNCING};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::{Mutex, atomic::Ordering};

struct Pending { remote: String, state: String, identity: String }
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

#[derive(Clone, Serialize)]
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
    remote == "comet-google" || remote.strip_prefix("comet-icloud-").is_some_and(|id| id.len() == 32 && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)))
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
    if step.0.complete { verified_icloud(&engine, &remote).await?; }
    else { *PENDING.lock().map_err(|_| "Cloud sign-in state is unavailable.")? = Some(Pending { remote: remote.clone(), state: state(&step.1)?.into(), identity: account_identity }); }
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
#[tauri::command]
pub async fn rclone_connect_google(app: tauri::AppHandle) -> Result<(), String> {
    let _guard = lock_cloud()?;
    let credentials = tauri::async_runtime::spawn_blocking(|| google::read_credentials("drive")).await.map_err(|_| "Couldn't read Google authorization.")??;
    let access = google::token("drive").await?;
    let engine = Engine::start(app).await?;
    let token = json!({"access_token":access,"token_type":"Bearer","refresh_token":credentials.refresh_token,"expiry":"2000-01-01T00:00:00Z"}).to_string();
    let mut result = engine.call("config/create", json!({"name":"comet-google","type":"drive","parameters":{"client_id":credentials.client_id,"client_secret":credentials.client_secret,"scope":"drive.file","token":token,"config_refresh_token":"false","config_change_team_drive":"false"},"opt":{"nonInteractive":true}})).await?;
    for _ in 0..4 {
        let current = state(&result)?.to_string();
        if current.is_empty() { return Ok(()); }
        let name = result.get("Option").and_then(|v| v.get("Name")).and_then(Value::as_str).unwrap_or("");
        if !matches!(name, "config_refresh_token" | "config_change_team_drive") { return Err("Google Drive requires additional setup. Reconnect Google and try again.".into()); }
        result = engine.call("config/update", json!({"name":"comet-google","parameters":{},"opt":{"continue":true,"nonInteractive":true,"state":current,"result":"false"}})).await?;
    }
    Err("Google Drive returned too many sign-in steps.".into())
}
#[tauri::command]
pub async fn rclone_accounts(app: tauri::AppHandle) -> Result<Vec<Account>, String> {
    let _guard = lock_cloud()?; let engine = Engine::start(app).await?;
    let remotes = engine.call("config/listremotes", json!({})).await?;
    let mut accounts = Vec::new();
    for name in remotes.get("remotes").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).filter(|name| remote_ok(name)) {
        let data = engine.call("config/get", json!({"name":name})).await?;
        if name == "comet-google" && data.get("type").and_then(Value::as_str) == Some("drive") {
            accounts.push(Account { remote: name.into(), provider: "google".into(), identity: "google".into(), label: "Google Drive".into() });
        } else if name.starts_with("comet-icloud-") && data.get("type").and_then(Value::as_str) == Some("iclouddrive") && data.get("trust_token").and_then(Value::as_str).is_some_and(|v| !v.is_empty()) {
            if let Some(apple_id) = data.get("apple_id").and_then(Value::as_str) { accounts.push(Account { remote: name.into(), provider: "icloud".into(), identity: identity(apple_id), label: apple_id.into() }); }
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
