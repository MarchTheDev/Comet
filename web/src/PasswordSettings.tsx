import { useEffect, useRef, useState, type FormEvent } from "react";
import { Copy, Download, KeyRound, Settings2, Trash2, X } from "lucide-react";
import { derivePasswordKey, encryptPasswordData, generateRecoveryCode, makeRecoveryRecord, packPasswordStorage, PASSWORD_ITERATIONS, PASSWORD_STORAGE_KEY, readPasswordStorage, unlockPasswordData, unlockPasswordRecovery } from "./utils/passwords";

export const PASSWORD_ICONS_KEY = "comet:password-site-icons:v1";
type Panel = "change" | "recovery" | "erase" | null;
type Candidate = { expected: string; raw: string; code: string; panel: "change" | "recovery" };
function readStored(): string | null { return localStorage.getItem(PASSWORD_STORAGE_KEY); }

/** Password management never requires the password list to be unlocked. */
export function PasswordSettings({ onOpenVault }: { onOpenVault: () => void }) {
  const [stored, setStored] = useState<string | null | undefined>(() => { try { return readStored(); } catch { return undefined; } });
  const [icons, setIcons] = useState(() => { try { return localStorage.getItem(PASSWORD_ICONS_KEY) !== "false"; } catch { return true; } });
  const [panel, setPanel] = useState<Panel>(null), [method, setMethod] = useState<"master" | "recovery">("master");
  const [credential, setCredential] = useState(""), [newMaster, setNewMaster] = useState(""), [confirm, setConfirm] = useState(""), [deleteText, setDeleteText] = useState("");
  const [candidate, setCandidate] = useState<Candidate | null>(null), [saved, setSaved] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const working = useRef(false), generation = useRef(0);
  const source = stored ? readPasswordStorage(stored) : null;
  const closePanel = () => { generation.current++; setPanel(null); setMethod("master"); setCredential(""); setNewMaster(""); setConfirm(""); setDeleteText(""); setCandidate(null); setSaved(false); setError(""); };
  useEffect(() => {
    const hide = () => { if (document.hidden) closePanel(); };
    document.addEventListener("visibilitychange", hide);
    return () => { generation.current++; document.removeEventListener("visibilitychange", hide); };
  }, []);
  useEffect(() => {
    if (!panel) return;
    let timer = window.setTimeout(closePanel, 5 * 60_000);
    const activity = () => { window.clearTimeout(timer); timer = window.setTimeout(closePanel, 5 * 60_000); };
    window.addEventListener("pointerdown", activity); window.addEventListener("keydown", activity);
    return () => { window.clearTimeout(timer); window.removeEventListener("pointerdown", activity); window.removeEventListener("keydown", activity); };
  }, [panel]);
  const openPanel = (next: Panel) => { closePanel(); setNotice(""); setPanel(next); };
  const commit = (expected: string, raw: string, message: string) => {
    if (document.hidden) throw new Error("The app was hidden. Nothing was changed.");
    if (readStored() !== expected) throw new Error("This vault changed elsewhere. Nothing was overwritten; reopen password settings to reload.");
    localStorage.setItem(PASSWORD_STORAGE_KEY, raw); setStored(raw); closePanel(); setNotice(message);
  };
  const prepare = async (event: FormEvent) => {
    event.preventDefault(); if (!stored || !panel || panel === "erase" || working.current) return;
    working.current = true; setBusy(true); setError(""); const expected = stored, started = ++generation.current, action = panel;
    try {
      const storage = readPasswordStorage(expected); if (!storage) throw new Error("Unknown or damaged vault; nothing was changed.");
      let raw = "", code = "";
      if (action === "recovery") {
        const verified = await unlockPasswordData(storage.envelope, credential, true);
        code = generateRecoveryCode();
        raw = packPasswordStorage(storage.envelope, await makeRecoveryRecord(verified.key, verified.salt, code));
      } else {
        if (newMaster.length < 12 || newMaster !== confirm) throw new Error("Use matching new master passwords of at least 12 characters.");
        const verified = method === "recovery" ? await unlockPasswordRecovery(expected, credential) : await unlockPasswordData(storage.envelope, credential);
        const salt = crypto.getRandomValues(new Uint8Array(16)), key = await derivePasswordKey(newMaster, salt, PASSWORD_ITERATIONS, true);
        const envelope = await encryptPasswordData(verified.data, key, salt);
        code = storage.recovery ? generateRecoveryCode() : "";
        const recovery = code ? await makeRecoveryRecord(key, salt, code) : null;
        raw = packPasswordStorage(envelope, recovery);
      }
      if (started !== generation.current || document.hidden) return;
      if (readStored() !== expected) throw new Error("This vault changed elsewhere. Nothing was overwritten; reopen password settings to reload.");
      setCredential(""); setNewMaster(""); setConfirm("");
      if (code) { setCandidate({ expected, raw, code, panel: action }); setSaved(false); }
      else commit(expected, raw, "Master password changed. Make a new encrypted backup; earlier backups keep their old password.");
    } catch (reason) { if (started === generation.current) setError(reason instanceof Error ? reason.message : "Couldn't update password settings."); }
    finally { working.current = false; setBusy(false); }
  };
  const confirmCandidate = () => {
    if (!candidate || !saved || working.current) return;
    try { commit(candidate.expected, candidate.raw, candidate.panel === "change" ? "Master password changed. Your saved passwords remain in the vault. Make a new encrypted backup." : "Recovery is enabled. Make a new encrypted backup; older backups keep their previous recovery settings."); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Couldn't save the change."); }
  };
  const erase = (event: FormEvent) => {
    event.preventDefault(); if (!stored || document.hidden || deleteText !== "DELETE" || working.current) return;
    try {
      if (readStored() !== stored) throw new Error("This vault changed elsewhere. Nothing was deleted; reopen password settings to reload.");
      localStorage.removeItem(PASSWORD_STORAGE_KEY); setStored(null); closePanel(); setNotice("The device vault was erased. Encrypted backups elsewhere were not deleted.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Couldn't erase the device vault."); }
  };
  const backup = () => {
    if (!stored) return;
    try {
      if (readStored() !== stored) throw new Error("This vault changed elsewhere. Reopen password settings before making a backup.");
      const url = URL.createObjectURL(new Blob([stored], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = "comet-passwords-encrypted.json"; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : "Couldn't create a backup."); }
  };
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); setNotice("Recovery code copied. Your clipboard may retain it until you replace it."); } catch { setNotice("Couldn't access the clipboard; select and copy the code instead."); } };
  return <section className="settings-card password-settings" aria-labelledby="password-settings-title">
    <div className="settings-card-heading"><div><h2 id="password-settings-title">Password vault</h2><p>Manage your device vault, recovery and backups.</p></div><KeyRound size={20} /></div>
    {stored === undefined ? <p className="dialog-error" role="alert">Device storage isn't available. Your vault has not been changed.</p> : <>
      <div className="setting-row"><span className="setting-copy"><strong>{stored ? "Device vault" : "No vault on this device"}</strong><small>{stored ? source?.recovery ? "Recovery code is enabled." : "Recovery code is not set up." : "Create a vault or import an encrypted backup."}</small></span><button type="button" className="secondary-button" onClick={onOpenVault}><KeyRound size={15} /> Open passwords</button></div>
      <label className="setting-row"><span className="setting-copy"><strong>Load site icons</strong><small>Google receives website domains, not usernames or passwords.</small></span><input className="setting-toggle" type="checkbox" aria-label="Load site icons" checked={icons} onChange={(event) => { const enabled = event.target.checked; setIcons(enabled); try { localStorage.setItem(PASSWORD_ICONS_KEY, String(enabled)); } catch { setNotice("The icon setting is available only for this session."); } }} /></label>
      {stored && <><div className="password-settings-actions"><button type="button" className="secondary-button" onClick={() => openPanel("change")}><Settings2 size={15} /> Change master password</button><button type="button" className="secondary-button" onClick={() => openPanel("recovery")}>{source?.recovery ? "Replace recovery code" : "Set up recovery"}</button><button type="button" className="secondary-button" onClick={backup}><Download size={15} /> Encrypted backup</button><button type="button" className="password-reset-link" onClick={() => openPanel("erase")}><Trash2 size={15} /> Forgot both? Erase this vault</button></div></>}
    </>}
    {panel && <div className="password-recovery-panel"><div className="password-form-heading"><h3>{panel === "change" ? "Change master password" : panel === "recovery" ? "Recovery code" : "Erase this password vault?"}</h3><button type="button" aria-label="Close password settings panel" onClick={closePanel}><X size={16} /></button></div>
      {panel === "erase" ? <form onSubmit={erase}><p className="password-warning">This permanently deletes every password stored in this device vault. This cannot be undone. Encrypted backups elsewhere are not deleted.</p><label>Type DELETE to confirm<input aria-label="Type DELETE to confirm" autoComplete="off" spellCheck={false} value={deleteText} onChange={(event) => setDeleteText(event.target.value)} /></label><button type="submit" className="password-delete" disabled={deleteText !== "DELETE"}>Erase all passwords</button></form> : candidate ? <><p>Save your new recovery code before continuing. It will not be shown again. Older backups keep their previous password and recovery code.</p><code>{candidate.code}</code><button type="button" className="secondary-button" onClick={() => void copy(candidate.code)}><Copy size={15} /> Copy code</button><label><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} /> I saved the recovery code somewhere safe.</label><button type="button" className="primary-button" disabled={!saved} onClick={confirmCandidate}>{candidate.panel === "change" ? "Confirm master password change" : "Enable recovery"}</button></> : <form onSubmit={(event) => void prepare(event)}>
        {panel === "change" ? <><p>Use your current master password or recovery code. Your saved passwords stay in the vault.</p><label>Verify with<select aria-label="Verify with" value={method} onChange={(event) => { setMethod(event.target.value as "master" | "recovery"); setCredential(""); setError(""); }}><option value="master">Current master password</option><option value="recovery" disabled={!source?.recovery}>Recovery code</option></select></label><label>{method === "master" ? "Current master password" : "Recovery code"}<input aria-label={method === "master" ? "Current master password" : "Recovery code"} type={method === "master" ? "password" : "text"} autoComplete="off" spellCheck={false} value={credential} onChange={(event) => setCredential(event.target.value)} required /></label><label>New master password<input type="password" autoComplete="new-password" minLength={12} value={newMaster} onChange={(event) => setNewMaster(event.target.value)} required /></label><label>Confirm new master password<input type="password" autoComplete="new-password" minLength={12} value={confirm} onChange={(event) => setConfirm(event.target.value)} required /></label><button type="submit" className="primary-button" disabled={busy}>{busy ? "Working…" : "Change password"}</button></> : <><p>Confirm your master password, then save the recovery code separately from your encrypted backup.</p><label>Master password<input type="password" autoComplete="current-password" value={credential} onChange={(event) => setCredential(event.target.value)} required /></label><button type="submit" className="primary-button" disabled={busy}>{busy ? "Working…" : "Create recovery code"}</button></>}
      </form>}
      {error && <p className="dialog-error" role="alert">{error}</p>}
    </div>}
    {notice && <p className="password-notice" role="status">{notice}</p>}
  </section>;
}
