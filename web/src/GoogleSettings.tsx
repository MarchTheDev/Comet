import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Cloud, Download, ExternalLink, RefreshCw, UploadCloud } from "lucide-react";
import { saveDriveBinding, validBinding as validIncrementalBinding } from "./utils/incrementalSync";
import type { IncrementalDriveController } from "./utils/useIncrementalDrive";
const CLIENT_KEY = "comet:google-client-id:v1";
const BUILTIN_ID = (import.meta.env?.VITE_GOOGLE_CLIENT_ID ?? "").trim();
// Google desktop client secrets are public app configuration, not a private credential.
const BUILTIN_SECRET = import.meta.env?.VITE_GOOGLE_CLIENT_SECRET ?? "";
const bindingKey = (vault: string) => `comet:google-sync:v1:${encodeURIComponent(vault)}`;
interface Binding { group: string; base: string }
interface Snapshot { id: string; name: string; modifiedTime?: string; size?: string }
interface SyncWorkspace { group: string; id: string; name: string; modified: string; branches: number }
interface SyncResult extends Binding { applied: number; conflicts: number; deleted: number; safetyFolder: string | null; more: boolean }
function validBinding(value: unknown): value is Binding { const b = value as Binding | null; return !!b && typeof b.group === "string" && /^[0-9a-f]{32}$/i.test(b.group) && typeof b.base === "string" && /^[a-z0-9_-]{1,200}$/i.test(b.base); }
function readBinding(vault: string): Binding | null { try { const value: unknown = JSON.parse(localStorage.getItem(bindingKey(vault)) || "null"); return validBinding(value) ? value : null; } catch { return null; } }
function saveBinding(vault: string, binding: Binding) { if (!validBinding(binding)) throw new Error("Invalid workspace sync state."); localStorage.setItem(bindingKey(vault), JSON.stringify(binding)); }
export function GoogleSettings({ desktop, vault, isSample, onImported, onSyncStart = async () => true, onSyncEnd = async () => {}, incremental }: { desktop: boolean; vault: string; isSample: boolean; onImported: (path: string) => void; onSyncStart?: () => Promise<boolean>; onSyncEnd?: () => Promise<void>; incremental?: IncrementalDriveController }) {
  const [clientId, setClientId] = useState(() => { if (BUILTIN_ID) return BUILTIN_ID; try { return localStorage.getItem(CLIENT_KEY) ?? ""; } catch { return ""; } });
  const [clientSecret, setClientSecret] = useState(BUILTIN_SECRET), [connected, setConnected] = useState(false), [legacy, setLegacy] = useState(false), [checking, setChecking] = useState(desktop), [busy, setBusy] = useState(""), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]), [workspaces, setWorkspaces] = useState<SyncWorkspace[]>([]), [incrementalWorkspaces, setIncrementalWorkspaces] = useState<SyncWorkspace[]>([]), [binding, setBinding] = useState(() => readBinding(vault));
  useEffect(() => setBinding(readBinding(vault)), [vault]);
  const refreshDrive = useCallback(async () => {
    const [old, synced, automatic] = await Promise.all([invoke<unknown>("google_drive_list"), invoke<unknown>("google_sync_list"), incremental ? invoke<unknown>("google_incremental_list") : Promise.resolve([])]);
    setSnapshots(Array.isArray(old) ? old.filter((item): item is Snapshot => item && typeof item.id === "string" && typeof item.name === "string").slice(0, 1000) : []);
    setWorkspaces(Array.isArray(synced) ? synced.filter((item): item is SyncWorkspace => item && validBinding({ group: item.group, base: item.id }) && typeof item.name === "string" && typeof item.branches === "number").slice(0, 1000) : []);
    setIncrementalWorkspaces(Array.isArray(automatic) ? automatic.filter((item): item is SyncWorkspace => item && validBinding({ group: item.group, base: item.id }) && typeof item.name === "string" && typeof item.branches === "number").slice(0, 1000) : []);
  }, [!!incremental]);
  useEffect(() => { if (!desktop) return; let active = true; void Promise.all([invoke<boolean>("google_status", { service: "all" }), invoke<boolean>("google_status", { service: "calendar" }), invoke<boolean>("google_status", { service: "drive" })]).then(([all, calendar, drive]) => { if (active) { setConnected(all); setLegacy(!all && (calendar || drive)); incremental?.connectionChanged(all || drive); } }).catch((reason) => { if (active) setError(String(reason)); }).finally(() => { if (active) setChecking(false); }); return () => { active = false; }; }, [desktop]);
  useEffect(() => { if (connected) void refreshDrive().catch((reason) => setError(String(reason))); else { setSnapshots([]); setWorkspaces([]); setIncrementalWorkspaces([]); } }, [connected, refreshDrive]);
  const connect = async () => { setBusy("connect"); setError(""); setMessage(""); try { try { localStorage.setItem(CLIENT_KEY, clientId.trim()); } catch {} await invoke("google_connect", { service: "all", clientId: clientId.trim(), clientSecret }); setConnected(true); setLegacy(false); incremental?.connectionChanged(true); } catch (reason) { setError(String(reason)); } finally { setBusy(""); } };
  const disconnect = async () => { setBusy("disconnect"); setError(""); setMessage(""); try { await invoke("google_disconnect", { service: "all" }); setConnected(false); setLegacy(false); incremental?.connectionChanged(false); setMessage("Disconnected on this device. You can also revoke Comet in your Google account."); } catch (reason) { setError(String(reason)); } finally { setBusy(""); } };
  const sync = async () => {
    if (incremental?.binding) { setError("Pause automatic sync and use a separate workspace for legacy sync. The two histories are independent."); return; }
    if (!binding && !window.confirm("Sync this workspace with Google Drive? Comet uploads unencrypted files. Passwords, settings and local-only calendar events are excluded.")) return;
    setBusy("sync"); setError(""); setMessage(""); let started = false;
    try {
      if (!(started = await onSyncStart())) return;
      let current = binding, last: SyncResult | null = null;
      let applied = 0, deleted = 0, conflicts = 0; const safetyFolders: string[] = [];
      for (let count = 0; count < 5; count++) {
        const next: SyncResult = await invoke("google_sync_now", { vault, group: current?.group ?? "", base: current?.base ?? "" });
        if (!validBinding(next)) throw new Error("Google returned invalid sync state; local files were preserved.");
        current = { group: next.group, base: next.base };
        try { saveBinding(vault, current); } catch { throw new Error("The sync revision was uploaded but this device couldn't save its sync state. Your files are safe; storage must be available before retrying."); }
        setBinding(current); last = next; applied += next.applied; deleted += next.deleted; conflicts += next.conflicts;
        if (next.safetyFolder) safetyFolders.push(next.safetyFolder);
        if (!next.more) break;
      }
      setMessage(last ? `Sync complete. ${applied} incoming changes, ${deleted} deletions, ${conflicts} conflict copies.${safetyFolders.length ? ` Replaced or deleted originals were kept in: ${safetyFolders.join(", ")}.` : ""}${last.more ? " More concurrent revisions remain; sync again." : ""}` : "Sync complete.");
      await refreshDrive();
    } catch (reason) { setError(String(reason)); } finally { try { if (started) await onSyncEnd(); } catch { setError("Sync finished, but the workspace could not be refreshed. Reopen it before editing."); } finally { setBusy(""); } }
  };
  const importSynced = async (item: SyncWorkspace) => {
    setBusy(item.id); setError(""); setMessage("");
    try {
      const imported = await invoke<{ path: string; group: string; base: string } | null>("google_sync_import", { id: item.id, group: item.group });
      if (imported?.path && validBinding(imported)) { saveBinding(imported.path, imported); onImported(imported.path); }
    } catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  };
  const importIncremental = async (item: SyncWorkspace) => {
    setBusy(`auto:${item.id}`); setError(""); setMessage("");
    try {
      const imported = await invoke<{ path: string; group: string; base: string } | null>("google_incremental_import", { id: item.id, group: item.group });
      if (imported?.path && validIncrementalBinding({ ...imported, enabled: true })) {
        try { saveDriveBinding(imported.path, { group: imported.group, base: imported.base, enabled: true }); }
        catch { throw new Error(`The workspace was imported into ${imported.path}, but its sync state could not be saved. Free device storage before connecting it.`); }
        onImported(imported.path);
      }
    } catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  };
  const startAutomatic = async () => {
    const legacyNotice = binding ? " This creates a separate automatic workspace; existing manual revisions remain on Drive but will no longer follow these changes. Import the new automatic workspace on your other devices." : "";
    if (!window.confirm(`Start automatic Drive sync for this workspace? Files are not encrypted by Comet. The device password vault, settings and local calendar are excluded. Workspaces are limited to 128 MB and 20,000 items.${legacyNotice}`)) return;
    await incremental?.start();
    await refreshDrive().catch((reason) => setError(String(reason)));
  };
  const backup = async () => {
    if (!window.confirm("Upload this workspace's files to Google Drive? Comet does not encrypt the snapshot. Passwords, local calendar events and settings are not included.")) return;
    setBusy("backup"); setError(""); setMessage("");
    try { await invoke("google_drive_backup", { vault }); setMessage("Backup uploaded."); await refreshDrive(); }
    catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  };
  const restore = async (id: string) => { setBusy(id); setError(""); setMessage(""); try { const path = await invoke<string | null>("google_drive_import", { id }); if (path) onImported(path); } catch (reason) { setError(String(reason)); } finally { setBusy(""); } };
  return <section className="settings-card google-settings" aria-labelledby="cloud-title"><div className="settings-card-heading"><div><h2 id="cloud-title">Connect Google</h2><p>Sign in once in your browser to connect your Google Calendar and Drive.</p></div><Cloud size={20} /></div>
    {!BUILTIN_ID && <div className="google-setup"><strong>Google sign-in is not configured in this build</strong><p>The project owner needs to register Comet once with Google and include the client in a release. Users will then only need to click Connect and sign in.</p><details><summary>Developer: configure a Desktop OAuth client</summary><label>Desktop client ID<input aria-label="Google OAuth client ID" autoComplete="off" placeholder="…apps.googleusercontent.com" value={clientId} onChange={(event) => setClientId(event.target.value)} /></label><label>Client secret <small>if required</small><input aria-label="Google OAuth client secret" type="password" autoComplete="off" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} /></label><a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer"><ExternalLink size={13} /> Google Cloud credentials</a></details></div>}
    <div className="setting-row"><span className="setting-copy"><strong>Google account</strong><small>{connected ? "Connected for Google Calendar and Comet-created Drive files." : legacy ? "Reconnect once to combine your earlier Calendar and Drive connections." : "A Google browser page will ask for Calendar events and access to Comet-created Drive files."}</small></span>{connected ? <button type="button" className="secondary-button" disabled={!!busy || checking} onClick={() => void disconnect()}>Disconnect</button> : <button type="button" className="primary-button" disabled={!desktop || !!busy || checking || !clientId.trim()} onClick={() => void connect()}>{busy === "connect" ? "Waiting for browser…" : "Connect Google"}</button>}</div>
    {connected && incremental && <div className="drive-snapshots drive-automatic"><h3>Automatic workspace sync <small>preview</small></h3><p>While Comet is open, it checks for changes and transfers changed files rather than the whole workspace. Offline changes stay local and retry when connected. Conflicts are kept as separate copies; replaced or deleted originals are kept in a safety folder. Drive files are not encrypted by Comet. The device password vault, local calendar and settings are not synced. This preview supports workspaces up to 128 MB and 20,000 items; history uses Drive space and is not automatically pruned.</p>
      <div className="drive-sync-state" role="status"><span className={`drive-sync-dot ${incremental.status}`} /><strong>{!incremental.binding ? "Not connected for this workspace" : !incremental.connected ? "Google disconnected" : incremental.status === "synced" ? "Last sync complete" : incremental.status === "paused" ? "Paused on this device" : incremental.status === "error" ? "Sync needs attention" : incremental.status === "applying" ? "Applying incoming changes…" : incremental.status === "uploading" ? "Uploading changed files…" : incremental.status === "checking" ? "Checking Drive…" : "Waiting to sync"}</strong></div>
      {incremental.detail && <p className={incremental.status === "error" ? "dialog-error" : "drive-sync-detail"}>{incremental.detail}</p>}
      <div className="drive-actions">{!incremental.binding ? <button type="button" className="primary-button" disabled={!!busy || incremental.busy || isSample} onClick={() => void startAutomatic()}><RefreshCw size={15} /> {incremental.busy ? "Starting…" : "Start automatic sync"}</button> : <><button type="button" className="primary-button" disabled={!!busy || incremental.busy || !incremental.binding.enabled} onClick={() => void incremental.retry()}><RefreshCw size={15} /> Sync changes now</button>{incremental.binding.enabled ? <button type="button" className="secondary-button" disabled={incremental.busy} onClick={incremental.pause}>Pause</button> : <button type="button" className="secondary-button" disabled={incremental.busy} onClick={incremental.resume}>Resume</button>}</>}<button type="button" className="secondary-button" disabled={!!busy || incremental.busy} onClick={() => void refreshDrive().catch((reason) => setError(String(reason)))}>Refresh workspaces</button></div>
      {isSample && <small>Open a local workspace to sync it.</small>}<h3>Automatic workspaces</h3>{incrementalWorkspaces.length ? <ul>{incrementalWorkspaces.map((item) => <li key={item.group}><span><strong>{item.name}</strong><small>{item.modified ? new Date(item.modified).toLocaleString() : ""}{item.branches > 1 ? ` · ${item.branches} versions to merge` : ""}</small></span><button type="button" className="secondary-button" disabled={!!busy || incremental.busy} onClick={() => void importIncremental(item)}><Download size={15} /> {busy === `auto:${item.id}` ? "Importing…" : "Open on this device"}</button></li>)}</ul> : <p>No automatic workspaces found for this account and OAuth client.</p>}
    </div>}
    {connected && <div className="drive-snapshots"><h3>{incremental ? "Legacy manual sync" : "Workspace sync"}</h3><p>Sync is currently manual: use Sync now after changes and when switching devices. Sync uses three-way merging. Conflicting changes are kept as separate files; replaced or deleted originals are also saved in a safety folder beside your workspace. Drive data is not encrypted by Comet. Passwords, settings and local-only calendar events stay on this device. Each revision is a full snapshot limited to 128 MB and 20,000 items. History uses Drive space and is not automatically pruned.</p><div className="drive-actions"><button type="button" className="primary-button" disabled={!!busy || isSample || !!incremental?.binding || !!incremental?.busy} onClick={() => void sync()}><RefreshCw size={15} /> {busy === "sync" ? "Syncing…" : binding ? "Sync now" : "Start syncing this workspace"}</button><button type="button" className="secondary-button" disabled={!!busy} onClick={() => { setError(""); void refreshDrive().catch((reason) => setError(String(reason))); }}><RefreshCw size={15} /> Refresh</button></div><small>{isSample ? "Open a local workspace to sync it." : binding ? "This workspace is connected. Use Sync now after making changes or when switching devices." : "This workspace has not been connected to Drive yet."}</small><h3>Synced workspaces</h3>{workspaces.length ? <ul>{workspaces.map((item) => <li key={item.group}><span><strong>{item.name}</strong><small>{item.modified ? new Date(item.modified).toLocaleString() : ""}{item.branches > 1 ? ` · ${item.branches} versions to merge` : ""}</small></span><button type="button" className="secondary-button" disabled={!!busy} onClick={() => void importSynced(item)}><Download size={15} /> {busy === item.id ? "Importing…" : "Import on this device"}</button></li>)}</ul> : <p>No synced workspaces found for this account and OAuth client.</p>}
      <details className="google-backups"><summary>Older manual backups</summary><p>Snapshots remain separate from sync and always import into a new workspace.</p><button type="button" className="secondary-button" disabled={!!busy || isSample} onClick={() => void backup()}><UploadCloud size={15} /> Upload current workspace</button>{snapshots.length > 0 && <ul>{snapshots.map((snapshot) => <li key={snapshot.id}><span><strong>{snapshot.name}</strong><small>{snapshot.modifiedTime ? new Date(snapshot.modifiedTime).toLocaleString() : ""}</small></span><button type="button" className="secondary-button" disabled={!!busy} onClick={() => void restore(snapshot.id)}><Download size={15} /> Import as new</button></li>)}</ul>}</details></div>}
    {!desktop && <p className="desktop-settings-note">Google sign-in is available in the desktop app.</p>}{message && <p role="status">{message}</p>}{error && <p className="dialog-error" role="alert">{error}</p>}
  </section>;
}
