import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Cloud, Download, ExternalLink, RefreshCw, UploadCloud } from "lucide-react";
const CLIENT_KEY = "comet:google-client-id:v1";
type Service = "calendar" | "drive";
interface Snapshot { id: string; name: string; modifiedTime?: string; size?: string }
export function GoogleSettings({ desktop, vault, isSample, onImported }: { desktop: boolean; vault: string; isSample: boolean; onImported: (path: string) => void }) {
  const [clientId, setClientId] = useState(() => { try { return localStorage.getItem(CLIENT_KEY) ?? ""; } catch { return ""; } });
  const [clientSecret, setClientSecret] = useState(""), [calendar, setCalendar] = useState(false), [drive, setDrive] = useState(false), [checking, setChecking] = useState(desktop), [busy, setBusy] = useState(""), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const refreshDrive = useCallback(async () => {
    const result = await invoke<unknown>("google_drive_list");
    setSnapshots(Array.isArray(result) ? result.filter((item): item is Snapshot => item && typeof item.id === "string" && typeof item.name === "string").slice(0, 1000) : []);
  }, []);
  useEffect(() => { if (!desktop) return; let active = true; void Promise.all([invoke<boolean>("google_status", { service: "calendar" }), invoke<boolean>("google_status", { service: "drive" })]).then(([cal, storage]) => { if (active) { setCalendar(cal); setDrive(storage); } }).catch((reason) => { if (active) setError(String(reason)); }).finally(() => { if (active) setChecking(false); }); return () => { active = false; }; }, [desktop]);
  useEffect(() => { if (drive) void refreshDrive().catch((reason) => setError(String(reason))); else setSnapshots([]); }, [drive, refreshDrive]);
  const connect = async (service: Service) => { setBusy(service); setError(""); setMessage(""); try { try { localStorage.setItem(CLIENT_KEY, clientId.trim()); } catch {} await invoke("google_connect", { service, clientId: clientId.trim(), clientSecret }); if (service === "calendar") setCalendar(true); else setDrive(true); } catch (reason) { setError(String(reason)); } finally { setBusy(""); } };
  const disconnect = async (service: Service) => { setBusy(service); setError(""); setMessage(""); try { await invoke("google_disconnect", { service }); if (service === "calendar") setCalendar(false); else setDrive(false); } catch (reason) { setError(String(reason)); } finally { setBusy(""); } };
  const backup = async () => {
    if (!window.confirm("Upload this workspace's files to Google Drive? Comet does not encrypt the snapshot. Passwords, local calendar events and settings are not included.")) return;
    setBusy("backup"); setError(""); setMessage("");
    try { await invoke("google_drive_backup", { vault }); setMessage("Snapshot uploaded. On another device, connect with the same Google account and OAuth client to import it."); await refreshDrive(); }
    catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  };
  const restore = async (id: string) => {
    setBusy(id); setError(""); setMessage("");
    try { const path = await invoke<string | null>("google_drive_import", { id }); if (path) onImported(path); }
    catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  };
  const connection = (service: Service, connected: boolean) => connected ? <button type="button" className="secondary-button" disabled={!!busy || checking} onClick={() => void disconnect(service)}>Disconnect</button> : <button type="button" className="primary-button" disabled={!desktop || !!busy || checking || !clientId.trim()} onClick={() => void connect(service)}>{busy === service ? "Waiting for browser…" : "Connect"}</button>;
  return <section className="settings-card google-settings" aria-labelledby="cloud-title"><div className="settings-card-heading"><div><h2 id="cloud-title">Google connections</h2><p>Authorize Comet in your browser—no additional sync application is needed.</p></div><Cloud size={20} /></div>
    <div className="google-setup"><strong>One-time developer setup</strong><p>Until Comet has its own registered OAuth client, create a Google Cloud project, enable the Calendar API and/or Drive API, and create an OAuth client of type “Desktop app.” Enter that client's ID below. If Google requires its client secret, enter it here—not in chat. The secret and authorization are saved in your operating system's credential store.</p><label>Desktop client ID<input aria-label="Google OAuth client ID" autoComplete="off" placeholder="…apps.googleusercontent.com" value={clientId} onChange={(event) => setClientId(event.target.value)} /></label><label>Client secret <small>optional</small><input aria-label="Google OAuth client secret" type="password" autoComplete="off" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} /></label><a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer"><ExternalLink size={13} /> Google Cloud credentials</a></div>
    <div className="setting-row"><span className="setting-copy"><strong>Google Calendar</strong><small>{calendar ? "Connected. Google events appear in Calendar and can be edited there." : "Connect the primary calendar to view and edit Google events in Comet."}</small></span>{connection("calendar", calendar)}</div>
    <div className="setting-row"><span className="setting-copy"><strong>Google Drive workspace snapshots</strong><small>{drive ? "Connected with access only to files created by Comet." : "Connect to upload and import workspace snapshots."}</small></span>{connection("drive", drive)}</div>
    {drive && <div className="drive-snapshots"><p>Upload a snapshot on one device and import it as a <strong>new workspace</strong> on another. Snapshots are manual—not continuous or automatic merging—and Comet does not encrypt them. Files up to 128 MB total are supported; symbolic links are rejected. Device-local passwords, calendar events, preferences and workspace display metadata are not included.</p><div className="drive-actions"><button type="button" className="primary-button" disabled={!!busy || isSample} onClick={() => void backup()}><UploadCloud size={15} /> {busy === "backup" ? "Uploading…" : "Upload current workspace"}</button><button type="button" className="secondary-button" disabled={!!busy} onClick={() => { setError(""); void refreshDrive().catch((reason) => setError(String(reason))); }}><RefreshCw size={15} /> Refresh</button></div>{isSample && <small>Open a local workspace to upload it.</small>}<h3>Available snapshots</h3>{snapshots.length ? <ul>{snapshots.map((snapshot) => <li key={snapshot.id}><span><strong>{snapshot.name}</strong><small>{snapshot.modifiedTime ? new Date(snapshot.modifiedTime).toLocaleString() : ""}{snapshot.size ? ` · ${(Number(snapshot.size) / 1024 / 1024).toFixed(1)} MB` : ""}</small></span><button type="button" className="secondary-button" disabled={!!busy} onClick={() => void restore(snapshot.id)}><Download size={15} /> {busy === snapshot.id ? "Importing…" : "Import as new"}</button></li>)}</ul> : <p>No Comet snapshots found for this account and OAuth client.</p>}</div>}
    {!desktop && <p className="desktop-settings-note">Google sign-in is available in the desktop app.</p>}{message && <p role="status">{message}</p>}{error && <p className="dialog-error" role="alert">{error}</p>}
  </section>;
}
