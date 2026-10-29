import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Cloud, Download, RefreshCw } from "lucide-react";
import { AppSelect } from "./AppSelect";
import rcloneLicense from "./licenses/rclone.txt?raw";
import { saveRcloneBinding, type CloudAccount } from "./utils/rcloneBinding";
import type { RcloneController } from "./utils/useRcloneSync";

type AuthStep = { complete: boolean; remote: string; identity: string; prompt: string; choices: { value: string; label: string }[] };
type Workspace = { group: string; id: string; name: string; modified: string; branches: number };
interface Props { desktop: boolean; vault: string; isSample: boolean; controller?: RcloneController; onImported(path: string): void }

export function RcloneSettings({ desktop, isSample, controller, onImported }: Props) {
  const [form, setForm] = useState(false), [appleId, setAppleId] = useState(""), [password, setPassword] = useState("");
  const [step, setStep] = useState<AuthStep | null>(null), [answer, setAnswer] = useState("");
  const [selected, setSelected] = useState(""), [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [message, setMessage] = useState("");
  const account = controller?.accounts.find((item) => item.remote === selected) ?? null;
  useEffect(() => {
    const accounts = controller?.accounts ?? [];
    if (!accounts.some((item) => item.remote === selected)) setSelected(accounts[0]?.remote ?? "");
  }, [controller?.accounts, selected]);
  const handleStep = async (next: AuthStep) => {
    setStep(next); setAnswer("");
    if (!next.complete) return;
    // A successful reconnect replaces only the older local authorization for
    // the same Apple ID. Existing workspace and cloud revisions are untouched.
    const old = (controller?.accounts ?? []).filter((item) => item.provider === "icloud" && item.identity === next.identity && item.remote !== next.remote);
    for (const item of old) await invoke("rclone_disconnect", { remote: item.remote });
    await controller?.refreshAccounts(); setSelected(next.remote); setForm(false); setStep(null); setPassword("");
    setMessage("iCloud connected. Choose a workspace to sync or open one from this account.");
  };
  const begin = async () => {
    const secret = password; setPassword(""); setBusy("icloud"); setError(""); setMessage("");
    try { await handleStep(await invoke<AuthStep>("rclone_icloud_begin", { appleId, password: secret })); }
    catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  };
  const continueAuth = async () => {
    const response = answer; setAnswer(""); setBusy("verify"); setError("");
    try { await handleStep(await invoke<AuthStep>("rclone_icloud_continue", { answer: response })); }
    catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  };
  const cancel = async () => {
    setBusy("cancel"); setPassword(""); setAnswer("");
    try { await invoke("rclone_icloud_cancel"); } catch { /* no workspace data is affected */ }
    setStep(null); setForm(false); setBusy("");
  };
  const google = async () => {
    setBusy("google"); setError(""); setMessage("");
    try { await invoke("rclone_connect_google"); await controller?.refreshAccounts(); setSelected("comet-google"); setMessage("Google Drive is ready for rclone workspace sync."); }
    catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  };
  const list = async (active: CloudAccount) => {
    setBusy("list"); setError(""); setMessage("");
    try { setWorkspaces(await invoke<Workspace[]>("rclone_incremental_list", { remote: active.remote })); }
    catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  };
  const start = async () => {
    if (!account || !controller) return;
    if (!window.confirm("Start a separate rclone cloud workspace? Existing Google Drive sync history stays untouched. Workspace files and local caches are not end-to-end encrypted by Comet. The password vault, settings, and local calendar are excluded. This preview supports up to 128 MB and 20,000 items.")) return;
    await controller.start(account);
  };
  const open = async (item: Workspace) => {
    if (!account) return;
    setBusy(item.id); setError(""); setMessage("");
    try {
      const imported = await invoke<{ path: string; group: string; base: string } | null>("rclone_incremental_import", { remote: account.remote, group: item.group, id: item.id });
      if (imported) {
        saveRcloneBinding(imported.path, { group: imported.group, base: imported.base, enabled: true, remote: account.remote, identity: account.identity, provider: account.provider });
        onImported(imported.path);
      }
    } catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  };
  const disconnect = async () => {
    if (!account || !controller) return;
    if (!window.confirm(`Remove the local ${account.provider === "icloud" ? "iCloud" : "Google Drive"} authorization? Cloud files and revision history will not be deleted. You can reconnect later.`)) return;
    if (controller.binding?.enabled && controller.binding.provider === account.provider && controller.binding.identity === account.identity) controller.pause();
    setBusy("disconnect"); setError("");
    try { await invoke("rclone_disconnect", { remote: account.remote }); await controller.refreshAccounts(); setWorkspaces(null); setMessage("Local authorization removed; cloud history remains."); }
    catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  };
  return <section className="settings-card google-settings rclone-settings" aria-labelledby="rclone-title">
    <div className="settings-card-heading"><div><h2 id="rclone-title">Cloud workspace sync <small>preview</small></h2><p>Bundled rclone transports changes while Comet is open. Your files remain local first.</p></div><Cloud size={20} /></div>
    <p className="rclone-explainer">Changes are checked after saves and periodically. Offline work stays on this device and retries. Concurrent edits are kept as conflict copies; replaced or deleted originals go to a safety folder. Comet does not end-to-end encrypt workspace files or its local sync cache. Password vault, settings, and local-only calendar events are not synced. History uses cloud storage and is not pruned automatically. Current preview limit: 128 MB and 20,000 items per workspace.</p>
    <p className="rclone-explainer">A fully closed app cannot sync; enable close to tray to keep it running. Calendar uses its own Google authorization and is not provided by rclone.</p>
    <div className="drive-actions"><button type="button" className="secondary-button" disabled={!desktop || !!busy || !!controller?.busy} onClick={() => { setForm(true); setError(""); setMessage(""); }}>Connect iCloud Drive</button><button type="button" className="secondary-button" disabled={!desktop || !!busy || !!controller?.busy} onClick={() => void google()}>Use connected Google Drive</button><button type="button" className="secondary-button" disabled={!desktop || !!busy || !!controller?.busy} onClick={() => void controller?.refreshAccounts().catch((reason) => setError(String(reason)))}>Refresh accounts</button></div>
    <p className="rclone-explainer">Google Drive still needs the Google sign-in below; rclone does not bypass Google OAuth or its token policies.</p>
    {form && <div className="rclone-auth">
      <h3>Connect iCloud Drive <small>experimental</small></h3>
      <p>rclone’s iCloud Drive backend is experimental. It requires your regular Apple ID password and two-factor verification, not an app-specific password. Enable “Access iCloud Data on the Web” in Apple settings. Advanced Data Protection can require approval on a trusted device. Your password and session are stored in an encrypted local rclone configuration, protected by a key in your system credential store. The trusted session typically lasts about 30 days; you may need to sign in again.</p>
      {!step ? <form onSubmit={(event) => { event.preventDefault(); void begin(); }}><label>Apple ID<input autoComplete="username" value={appleId} onChange={(event) => setAppleId(event.target.value)} /></label><label>Apple ID password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><div className="drive-actions"><button className="primary-button" type="submit" disabled={!!busy || !appleId.trim() || !password}>{busy === "icloud" ? "Connecting…" : "Continue"}</button><button className="secondary-button" type="button" disabled={!!busy} onClick={() => void cancel()}>Cancel</button></div></form> : <form onSubmit={(event) => { event.preventDefault(); void continueAuth(); }}><label>{step.prompt || "Verification"}{step.choices.length ? <AppSelect label="Trusted phone" value={answer} onChange={setAnswer}><option value="" disabled>Choose a trusted phone</option>{step.choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</AppSelect> : <input aria-label="Apple verification code" autoComplete="one-time-code" value={answer} onChange={(event) => setAnswer(event.target.value)} />}</label><div className="drive-actions"><button type="submit" className="primary-button" disabled={!!busy || !answer.trim()}>{busy === "verify" ? "Verifying…" : "Verify"}</button><button type="button" className="secondary-button" disabled={!!busy} onClick={() => void cancel()}>Cancel</button></div></form>}
    </div>}
    {controller && (controller.accounts.length > 0 || controller.binding) && <div className="drive-snapshots drive-automatic">
      <h3>Connected accounts</h3><div className="rclone-account-row">{controller.accounts.length > 0 ? <AppSelect label="Cloud account" value={selected} onChange={(value) => { setSelected(value); setWorkspaces(null); }} disabled={!!busy || controller.busy}>{controller.accounts.map((item) => <option key={item.remote} value={item.remote}>{item.provider === "icloud" ? `iCloud · ${item.label}` : "Google Drive"}</option>)}</AppSelect> : <small>Reconnect the original account to resume sync.</small>}<button type="button" className="secondary-button" disabled={!account || !!busy || controller.busy} onClick={() => void disconnect()}>Disconnect</button></div>
      <div className="drive-sync-state" role="status"><span className={`drive-sync-dot ${controller.status}`} /><strong>{!controller.binding ? "Not syncing this workspace" : !controller.connected ? "Cloud account disconnected" : controller.status === "synced" ? "Last sync complete" : controller.status === "paused" ? "Paused on this device" : controller.status === "error" ? "Sync needs attention" : controller.status === "applying" ? "Applying incoming changes…" : controller.status === "uploading" ? "Uploading changed files…" : controller.status === "checking" ? "Checking cloud…" : "Waiting to sync"}</strong></div>
      {controller.detail && <p className={controller.status === "error" ? "dialog-error" : "drive-sync-detail"}>{controller.detail}</p>}
      <div className="drive-actions">{!controller.binding ? <button type="button" className="primary-button" disabled={!account || !!busy || controller.busy || isSample} onClick={() => void start()}><RefreshCw size={15} /> {controller.busy ? "Starting…" : "Start automatic sync"}</button> : <><button type="button" className="primary-button" disabled={!!busy || controller.busy || !controller.binding.enabled || !controller.connected} onClick={() => void controller.retry()}><RefreshCw size={15} /> Sync changes now</button>{controller.binding.enabled ? <button type="button" className="secondary-button" disabled={controller.busy} onClick={controller.pause}>Pause</button> : <button type="button" className="secondary-button" disabled={controller.busy} onClick={controller.resume}>Resume</button>}</>}<button type="button" className="secondary-button" disabled={!account || !!busy || controller.busy} onClick={() => account && void list(account)}>Find cloud workspaces</button></div>
      {isSample && <small>Open a local workspace to sync it.</small>}
      {workspaces && <><h3>Workspaces in {account?.provider === "icloud" ? "iCloud Drive" : "Google Drive"}</h3>{workspaces.length ? <ul>{workspaces.map((item) => <li key={item.group}><span><strong>{item.name}</strong><small>{item.modified ? new Date(item.modified).toLocaleString() : ""}{item.branches > 1 ? ` · ${item.branches} versions to merge` : ""}</small></span><button type="button" className="secondary-button" disabled={!!busy || controller.busy} onClick={() => void open(item)}><Download size={15} /> {busy === item.id ? "Opening…" : "Open on this device"}</button></li>)}</ul> : <p>No rclone workspaces found in this account.</p>}</>}
    </div>}
    <details className="rclone-license"><summary>rclone open-source notice</summary><pre>{rcloneLicense}</pre></details>
    {!desktop && <p className="desktop-settings-note">Cloud sync is available in bundled desktop builds.</p>}{message && <p role="status">{message}</p>}{error && <p className="dialog-error" role="alert">{error}</p>}
  </section>;
}
