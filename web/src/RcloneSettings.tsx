import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Cloud, Download, RefreshCw } from "lucide-react";
import { AppSelect } from "./AppSelect";
import rcloneLicense from "./licenses/rclone.txt?raw";
import { readRcloneBinding, saveRcloneBinding, type CloudAccount } from "./utils/rcloneBinding";
import type { RcloneController } from "./utils/useRcloneSync";

type AuthStep = { complete: boolean; remote: string; identity: string; prompt: string; choices: { value: string; label: string }[] };
type Workspace = { group: string; id: string; name: string; modified: string; branches: number };
type Consent = { account: CloudAccount; vault: string };
interface Props { desktop: boolean; vault: string; isSample: boolean; controller?: RcloneController; onImported(path: string): void }

/** Keep the scope and privacy decision inside Comet, before any upload starts. */
function SyncConsent({ onCancel, onConfirm }: { onCancel(): void; onConfirm(): void }) {
  const cancel = useRef<HTMLButtonElement>(null), confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  const keydown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
    else if (event.key === "Tab") {
      if (event.shiftKey && document.activeElement === cancel.current) { event.preventDefault(); confirm.current?.focus(); }
      else if (!event.shiftKey && document.activeElement === confirm.current) { event.preventDefault(); cancel.current?.focus(); }
    }
  };
  return <div className="modal-backdrop" onMouseDown={onCancel}>
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="sync-consent-title" aria-describedby="sync-consent-description" onMouseDown={(event) => event.stopPropagation()} onKeyDown={keydown}>
      <div className="modal-icon"><Cloud size={20} /></div>
      <h2 id="sync-consent-title">Start cloud sync?</h2>
      <p id="sync-consent-description">Comet syncs supported text, Markdown, to-dos and whiteboards. Separate media and other files stay on this device. Images and data embedded in synced files are included.</p>
      <p>Readable copies appear in your cloud storage. Edit files in Comet to sync changes; edits to these copies do not sync back. Cloud files and the local sync cache are not end-to-end encrypted.</p>
      <div className="modal-actions"><button ref={cancel} className="secondary-button" type="button" onClick={onCancel}>Not now</button><button ref={confirm} className="primary-button" type="button" onClick={onConfirm}>Start sync</button></div>
    </div>
  </div>;
}

export function RcloneSettings({ desktop, vault, isSample, controller, onImported }: Props) {
  const [form, setForm] = useState(false), [appleId, setAppleId] = useState(""), [password, setPassword] = useState("");
  const [step, setStep] = useState<AuthStep | null>(null), [answer, setAnswer] = useState("");
  const [selected, setSelected] = useState(""), [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [consent, setConsent] = useState<Consent | null>(null), [discovering, setDiscovering] = useState(false);
  const googleCancelled = useRef(false), googleAttempt = useRef(""), checkedAccount = useRef("");
  const account = controller?.accounts.find((item) => item.remote === selected) ?? null;
  useEffect(() => {
    const accounts = controller?.accounts ?? [];
    if (!accounts.some((item) => item.remote === selected)) setSelected(accounts[0]?.remote ?? "");
  }, [controller?.accounts, selected]);
  // A new device should still be able to open its existing workspace, without
  // a separate "find" action or silently joining an unrelated local folder.
  useEffect(() => {
    if (!desktop || !account || controller?.binding || busy || controller?.busy) return;
    const key = `${account.remote}:${account.identity}`;
    if (checkedAccount.current === key) return;
    checkedAccount.current = key;
    let active = true; setDiscovering(true);
    void invoke<Workspace[]>("rclone_incremental_list", { remote: account.remote }).then((found) => { if (active) setWorkspaces(found); })
      .catch((reason) => { if (active) { setError(String(reason)); checkedAccount.current = ""; } })
      .finally(() => { if (active) setDiscovering(false); });
    return () => { active = false; setDiscovering(false); };
  }, [desktop, account?.remote, account?.identity, controller?.binding, controller?.busy, busy]);
  const handleStep = async (next: AuthStep) => {
    setStep(next); setAnswer("");
    if (!next.complete) return;
    const old = (controller?.accounts ?? []).filter((item) => item.provider === "icloud" && item.identity === next.identity && item.remote !== next.remote);
    for (const item of old) await invoke("rclone_disconnect", { remote: item.remote });
    await controller?.refreshAccounts(); setSelected(next.remote); setForm(false); setStep(null); setPassword("");
    checkedAccount.current = ""; setMessage("iCloud connected. Choose what to sync.");
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
    const previous = controller?.binding;
    const wasEnabled = previous?.remote === "comet-rclone-google" && previous.enabled;
    if (wasEnabled) {
      controller?.pause();
      if (readRcloneBinding(vault)?.enabled) { setError("Couldn't pause sync before reconnecting. No connection was changed."); return; }
    }
    googleAttempt.current = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    googleCancelled.current = false; setBusy("google"); setError(""); setMessage("Continue Google sign-in in your browser…");
    let connected = false, cancelled = false, restorePrevious = true;
    try {
      const signedIn = await invoke<CloudAccount>("rclone_connect_google", { attemptId: googleAttempt.current });
      connected = true; googleCancelled.current = false; setBusy("google-setup");
      await controller?.refreshAccounts(); setSelected("comet-rclone-google");
      if (controller && (!previous || previous.remote === "comet-rclone-google") && !isSample) {
        // Check account identity and history before resuming; never silently
        // attach an unrelated local folder to an existing cloud workspace.
        const found = await invoke<Workspace[]>("rclone_incremental_list", { remote: "comet-rclone-google" });
        checkedAccount.current = `${signedIn.remote}:${signedIn.identity}`;
        if (previous) {
          if (previous.identity === signedIn.identity && ((previous.group && found.some((item) => item.group === previous.group)) || (!previous.group && !found.length))) {
            if (wasEnabled) { controller.resume(vault); setMessage("Google Drive connected. Sync will resume for this workspace."); }
            else setMessage("Google Drive connected. Sync remains paused until you resume it.");
          } else {
            setWorkspaces(found); setMessage("This account cannot see the workspace previously linked here. Sync remains paused.");
          }
        } else if (found.length) { setWorkspaces(found); setMessage("Google Drive connected. Open a saved workspace or start a separate one."); }
        else { setWorkspaces([]); setConsent({ account: signedIn, vault }); setMessage(""); }
      } else setMessage("Google Drive connected. Choose what to sync.");
    } catch (reason) {
      const text = String(reason);
      cancelled = googleCancelled.current && text.startsWith("Google sign-in was cancelled.");
      if (!cancelled) { setError(text); setMessage(connected ? "Google Drive connected, but the workspace check did not finish." : "Google sign-in did not finish."); }
      if (text.includes("could not restore the previous connection")) restorePrevious = false;
    } finally {
      if (!connected && wasEnabled && restorePrevious) controller?.resume(vault);
      if (cancelled) setMessage("Google sign-in cancelled. Existing files were not deleted.");
      setBusy("");
    }
  };
  const cancelGoogle = async () => {
    googleCancelled.current = true; setBusy("google-cancelling"); setMessage("Cancelling Google sign-in…");
    try { await invoke("rclone_cancel_google", { attemptId: googleAttempt.current }); } catch { /* the sign-in attempt also times out safely */ }
  };
  const start = () => { if (account && controller) setConsent({ account, vault }); };
  const confirmStart = async () => {
    const pending = consent; setConsent(null);
    if (!pending || !controller) return;
    if (pending.vault !== vault) { setMessage("The workspace changed. Start sync from the workspace you want to use."); return; }
    await controller.start(pending.account, pending.vault);
    setMessage("Check the sync status below for this workspace.");
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
    if (!window.confirm(`Remove the local ${account.provider === "icloud" ? "iCloud" : "Google Drive"} authorization? Cloud files and history will not be deleted.`)) return;
    if (controller.binding?.enabled && controller.binding.provider === account.provider && controller.binding.identity === account.identity) controller.pause();
    setBusy("disconnect"); setError("");
    try { await invoke("rclone_disconnect", { remote: account.remote }); await controller.refreshAccounts(); setWorkspaces(null); checkedAccount.current = ""; setMessage("Account disconnected; cloud files remain."); }
    catch (reason) { setError(String(reason)); } finally { setBusy(""); }
  };
  return <section className="settings-card google-settings rclone-settings" aria-labelledby="rclone-title">
    <div className="settings-card-heading"><div><h2 id="rclone-title">Cloud workspace sync</h2><p>Keep text and boards in sync across your devices.</p></div><Cloud size={20} /></div>
    <p className="rclone-explainer">Supported text, Markdown, to-dos and whiteboards sync; separate media stays on this device. Embedded images are included. Cloud files are not end-to-end encrypted.</p>
    <div className="drive-actions"><button type="button" className="secondary-button" disabled={!desktop || !!busy || discovering || !!controller?.busy} onClick={() => { setForm(true); setError(""); setMessage(""); }}>Connect iCloud Drive</button><button type="button" className="secondary-button" disabled={!desktop || discovering || (busy !== "google" && !!busy) || !!controller?.busy} onClick={() => busy === "google" ? void cancelGoogle() : void google()}>{busy === "google" ? "Cancel Google sign-in" : busy === "google-cancelling" ? "Cancelling…" : busy === "google-setup" ? "Finishing…" : "Connect Google Drive"}</button></div>
    <p className="rclone-explainer">Google's shared sign-in may stop working during 2026. iCloud support is experimental.</p>
    {form && <div className="rclone-auth">
      <h3>Connect iCloud Drive <small>experimental</small></h3>
      <p>Use your regular Apple ID password and two-factor verification, not an app-specific password. Enable “Access iCloud Data on the Web” in Apple settings. A trusted session typically lasts about 30 days. Your credentials are kept in encrypted local rclone configuration protected by your system credential store.</p>
      {!step ? <form onSubmit={(event) => { event.preventDefault(); void begin(); }}><label>Apple ID<input autoComplete="username" value={appleId} onChange={(event) => setAppleId(event.target.value)} /></label><label>Apple ID password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><div className="drive-actions"><button className="primary-button" type="submit" disabled={!!busy || !appleId.trim() || !password}>{busy === "icloud" ? "Connecting…" : "Continue"}</button><button className="secondary-button" type="button" disabled={!!busy} onClick={() => void cancel()}>Cancel</button></div></form> : <form onSubmit={(event) => { event.preventDefault(); void continueAuth(); }}><label>{step.prompt || "Verification"}{step.choices.length ? <AppSelect label="Trusted phone" value={answer} onChange={setAnswer}><option value="" disabled>Choose a trusted phone</option>{step.choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</AppSelect> : <input aria-label="Apple verification code" autoComplete="one-time-code" value={answer} onChange={(event) => setAnswer(event.target.value)} />}</label><div className="drive-actions"><button type="submit" className="primary-button" disabled={!!busy || !answer.trim()}>{busy === "verify" ? "Verifying…" : "Verify"}</button><button type="button" className="secondary-button" disabled={!!busy} onClick={() => void cancel()}>Cancel</button></div></form>}
    </div>}
    {controller && (controller.accounts.length > 0 || controller.binding) && <div className="drive-snapshots drive-automatic">
      <h3>Connected accounts</h3><div className="rclone-account-row">{controller.accounts.length > 0 ? <AppSelect label="Cloud account" value={selected} onChange={(value) => { setSelected(value); setWorkspaces(null); checkedAccount.current = ""; }} disabled={!!busy || discovering || controller.busy}>{controller.accounts.map((item) => <option key={item.remote} value={item.remote}>{item.provider === "icloud" ? `iCloud · ${item.label}` : item.label}</option>)}</AppSelect> : <small>Reconnect the original account to resume sync.</small>}<button type="button" className="secondary-button" disabled={!account || !!busy || discovering || controller.busy} onClick={() => void disconnect()}>Disconnect</button></div>
      <div className="drive-sync-state" role="status"><span className={`drive-sync-dot ${controller.status}`} /><strong>{!controller.binding ? "Not syncing this workspace" : !controller.connected ? "Cloud account disconnected" : controller.status === "synced" ? "Last sync complete" : controller.status === "paused" ? "Paused on this device" : controller.status === "error" ? "Sync needs attention" : controller.status === "applying" ? "Applying incoming changes…" : controller.status === "uploading" ? "Uploading changed files…" : controller.status === "checking" ? "Checking cloud…" : "Waiting to sync"}</strong></div>
      {controller.detail && <p className={controller.status === "error" ? "dialog-error" : "drive-sync-detail"}>{controller.detail}</p>}
      <div className="drive-actions">{!controller.binding ? <button type="button" className="primary-button" disabled={!account || !!busy || discovering || controller.busy || isSample} onClick={start}><RefreshCw size={15} /> {controller.busy ? "Starting…" : "Start automatic sync"}</button> : <><button type="button" className="primary-button" disabled={!!busy || discovering || controller.busy || !controller.binding.enabled || !controller.connected} onClick={() => void controller.retry()}><RefreshCw size={15} /> Sync changes now</button>{controller.binding.enabled ? <button type="button" className="secondary-button" disabled={controller.busy || discovering} onClick={controller.pause}>Pause</button> : <button type="button" className="secondary-button" disabled={controller.busy || discovering} onClick={() => controller.resume()}>Resume</button>}</>}</div>
      {isSample && <small>Open a local workspace to sync it.</small>}
      {discovering && <p role="status">Checking saved workspaces…</p>}
      {workspaces && workspaces.length > 0 && <><h3>Saved cloud workspaces</h3><ul>{workspaces.map((item) => <li key={item.group}><span><strong>{item.name}</strong><small>{item.modified ? new Date(item.modified).toLocaleString() : ""}{item.branches > 1 ? ` · ${item.branches} versions to merge` : ""}</small></span><button type="button" className="secondary-button" disabled={!!busy || discovering || controller.busy} onClick={() => void open(item)}><Download size={15} /> {busy === item.id ? "Opening…" : "Open on this device"}</button></li>)}</ul></>}
    </div>}
    <details className="rclone-license"><summary>Cloud sync details</summary><p>Changes retry while Comet is open. Text and board files are limited to 16 MB each. Conflicts are kept as separate copies. Readable copies appear in Comet-Sync under the workspace name with their normal filenames and are updated in place; edits made there do not sync back, and an edited copy is preserved beside the new one. The text-v2 folder is Comet's internal history. Earlier full-workspace history remains separate. Google Calendar stays local.</p><p>Cloud history and the local sync cache are not end-to-end encrypted. Old revisions are not automatically deleted.</p></details>
    <details className="rclone-license"><summary>rclone open-source notice</summary><pre>{rcloneLicense}</pre></details>
    {!desktop && <p className="desktop-settings-note">Cloud sync is available in bundled desktop builds.</p>}{message && <p role="status">{message}</p>}{error && <p className="dialog-error" role="alert">{error}</p>}
    {consent && <SyncConsent onCancel={() => { setConsent(null); setMessage("Sync has not started."); }} onConfirm={() => void confirmStart()} />}
  </section>;
}
