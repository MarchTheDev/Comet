import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Copy, Download, Eye, EyeOff, Globe, KeyRound, Lock, Plus, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import { derivePasswordKey, encryptPasswordData, faviconUrl, generateRecoveryCode, makePassword, makeRecoveryRecord, packPasswordStorage, PASSWORD_ITERATIONS, PASSWORD_STORAGE_KEY, passwordWebsite, readPasswordStorage, unlockPasswordData, unlockPasswordRecovery, type PasswordData, type PasswordEntry, type PasswordRecovery } from "./utils/passwords";

const ICONS_KEY = "comet:password-site-icons:v1";
const emptyEntry = (): PasswordEntry => ({ id: crypto.randomUUID(), name: "", website: "", username: "", password: "", notes: "" });
type Unlocked = { data: PasswordData; key: CryptoKey; salt: Uint8Array; iterations: number; raw: string; recovery: PasswordRecovery | null };
function SiteIcon({ website }: { website: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [website]);
  const url = faviconUrl(website);
  return url && !failed ? <img src={url} referrerPolicy="no-referrer" alt="" onError={() => setFailed(true)} /> : <Globe size={19} />;
}
function readStored(): string | null { return localStorage.getItem(PASSWORD_STORAGE_KEY); }

/** Encrypted, device-local vault. Never silently replaces another window's changes. */
export function PasswordsView() {
  const [stored, setStored] = useState<string | null | undefined>(() => { try { return readStored(); } catch { return undefined; } });
  const [vault, setVault] = useState<Unlocked | null>(null), [master, setMaster] = useState(""), [confirm, setConfirm] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [query, setQuery] = useState(""), [draft, setDraft] = useState<PasswordEntry | null>(null), [revealed, setRevealed] = useState(false), [deleting, setDeleting] = useState(""), [icons, setIcons] = useState(() => { try { return localStorage.getItem(ICONS_KEY) !== "false"; } catch { return true; } }), [importRaw, setImportRaw] = useState("");
  const sourceStorage = useMemo(() => stored || importRaw ? readPasswordStorage(stored || importRaw || "") : null, [stored, importRaw]);
  const [recovering, setRecovering] = useState(false), [recoveryCode, setRecoveryCode] = useState(""), [setupOpen, setSetupOpen] = useState(false), [setupMaster, setSetupMaster] = useState(""), [recoveryCandidate, setRecoveryCandidate] = useState<{ code: string; record: PasswordRecovery } | null>(null), [savedCode, setSavedCode] = useState(false);
  const [resetting, setResetting] = useState(false), [resetConfirmation, setResetConfirmation] = useState("");
  const [changeOpen, setChangeOpen] = useState(false), [oldMaster, setOldMaster] = useState(""), [newMaster, setNewMaster] = useState(""), [newConfirm, setNewConfirm] = useState("");
  const [changeCandidate, setChangeCandidate] = useState<{ next: Unlocked; previous: Unlocked; code: string } | null>(null), [savedNewCode, setSavedNewCode] = useState(false);
  const changeGeneration = useRef(0);
  const working = useRef(false), importFile = useRef<HTMLInputElement>(null), session = useRef(vault), generation = useRef(0), recoveryGeneration = useRef(0); session.current = vault;
  const lock = () => { generation.current++; recoveryGeneration.current++; changeGeneration.current++; session.current = null; setVault(null); setDraft(null); setRevealed(false); setMaster(""); setConfirm(""); setError(""); setNotice(""); setRecoveryCode(""); setRecovering(false); setSetupOpen(false); setSetupMaster(""); setRecoveryCandidate(null); setSavedCode(false); setResetting(false); setResetConfirmation(""); setChangeOpen(false); setOldMaster(""); setNewMaster(""); setNewConfirm(""); setChangeCandidate(null); setSavedNewCode(false); try { setStored(readStored()); } catch { setStored(undefined); } };
  useEffect(() => {
    const visibility = () => { if (document.hidden) lock(); };
    document.addEventListener("visibilitychange", visibility);
    return () => { generation.current++; session.current = null; document.removeEventListener("visibilitychange", visibility); };
  }, []);
  useEffect(() => {
    if (!vault) return;
    let timer = window.setTimeout(lock, 5 * 60_000);
    const activity = () => { window.clearTimeout(timer); timer = window.setTimeout(lock, 5 * 60_000); };
    window.addEventListener("pointerdown", activity); window.addEventListener("keydown", activity);
    return () => { window.clearTimeout(timer); window.removeEventListener("pointerdown", activity); window.removeEventListener("keydown", activity); };
  }, [Boolean(vault)]); // A new save must not reset the inactivity timer.
  const authenticate = async (event: FormEvent) => {
    event.preventDefault(); if (working.current || stored === undefined) return; working.current = true; setBusy(true); setError("");
    const started = generation.current;
    try {
      if (stored || importRaw) {
        const raw = stored || importRaw, storage = readPasswordStorage(raw);
        if (!storage) throw new Error("Unknown or damaged password vault; it has not been changed.");
        const result = await unlockPasswordData(storage.envelope, master);
        if (started !== generation.current || document.hidden) return;
        if (!stored) { if (readStored() !== null) throw new Error("A vault already exists on this device. It was not overwritten."); localStorage.setItem(PASSWORD_STORAGE_KEY, raw); setStored(raw); setImportRaw(""); }
        setVault({ ...result, raw, recovery: storage.recovery });
      } else {
        if (master.length < 12) throw new Error("Use a master password of at least 12 characters.");
        if (master !== confirm) throw new Error("The master passwords don't match.");
        if (readStored() !== null) throw new Error("A vault already exists on this device. Reload to unlock it.");
        const salt = crypto.getRandomValues(new Uint8Array(16)), key = await derivePasswordKey(master, salt);
        const data: PasswordData = { format: "comet-passwords-data", version: 1, entries: [] }, raw = await encryptPasswordData(data, key, salt);
        if (started !== generation.current || document.hidden) return;
        if (readStored() !== null) throw new Error("A vault was created elsewhere; it wasn't overwritten.");
        localStorage.setItem(PASSWORD_STORAGE_KEY, raw); setStored(raw); setVault({ data, key, salt, iterations: PASSWORD_ITERATIONS, raw, recovery: null });
      }
      setMaster(""); setConfirm("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Couldn't unlock the vault."); }
    finally { working.current = false; setBusy(false); }
  };
  const save = async (data: PasswordData): Promise<boolean> => {
    if (!vault || working.current) return false; working.current = true; setBusy(true); setError("");
    try {
      const envelope = await encryptPasswordData(data, vault.key, vault.salt, vault.iterations);
      const raw = packPasswordStorage(envelope, vault.recovery);
      if (session.current !== vault) throw new Error("The vault was locked while saving. Please unlock it and try again.");
      if (readStored() !== vault.raw) throw new Error("This vault changed elsewhere. Your edits weren't saved; lock and unlock it to reload.");
      localStorage.setItem(PASSWORD_STORAGE_KEY, raw); setStored(raw); setVault({ ...vault, data, raw }); return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Couldn't save. Your edit is still open."); return false; }
    finally { working.current = false; setBusy(false); }
  };
  const beginRecoverySetup = async (event: FormEvent) => {
    event.preventDefault(); if (!vault || working.current) return; working.current = true; setBusy(true); setError("");
    const started = generation.current, setupStarted = ++recoveryGeneration.current;
    try {
      const storage = readPasswordStorage(vault.raw); if (!storage) throw new Error("Unknown or damaged vault.");
      const verified = await unlockPasswordData(storage.envelope, setupMaster, true);
      const code = generateRecoveryCode(), record = await makeRecoveryRecord(verified.key, verified.salt, code);
      if (started !== generation.current || setupStarted !== recoveryGeneration.current || session.current !== vault || document.hidden) return;
      setSetupMaster(""); setRecoveryCandidate({ code, record }); setSavedCode(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Couldn't set up recovery."); }
    finally { working.current = false; setBusy(false); }
  };
  const confirmRecoverySetup = () => {
    if (!vault || !recoveryCandidate || !savedCode) return;
    try {
      if (readStored() !== vault.raw) throw new Error("This vault changed elsewhere. Lock and unlock before setting recovery.");
      const storage = readPasswordStorage(vault.raw); if (!storage) throw new Error("Unknown or damaged vault.");
      const raw = packPasswordStorage(storage.envelope, recoveryCandidate.record);
      localStorage.setItem(PASSWORD_STORAGE_KEY, raw); setStored(raw); setVault({ ...vault, raw, recovery: recoveryCandidate.record });
      setRecoveryCandidate(null); setSetupOpen(false); setSavedCode(false); setNotice("Recovery is enabled. Make a new encrypted backup; older backups do not gain this recovery code.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Couldn't save recovery data."); }
  };
  const resetWithRecovery = async (event: FormEvent) => {
    event.preventDefault(); const oldRaw = stored || importRaw; if (!oldRaw || working.current) return;
    working.current = true; setBusy(true); setError(""); const started = generation.current;
    try {
      if (master.length < 12 || master !== confirm) throw new Error("Use matching master passwords of at least 12 characters.");
      const recovered = await unlockPasswordRecovery(oldRaw, recoveryCode);
      const salt = crypto.getRandomValues(new Uint8Array(16)), wrappingKey = await derivePasswordKey(master, salt, PASSWORD_ITERATIONS, true);
      const envelope = await encryptPasswordData(recovered.data, wrappingKey, salt), recovery = await makeRecoveryRecord(wrappingKey, salt, recoveryCode);
      // Keep the normal unlocked-session key non-extractable, as in v1.
      const key = await derivePasswordKey(master, salt, PASSWORD_ITERATIONS);
      const raw = packPasswordStorage(envelope, recovery);
      if (started !== generation.current || document.hidden) return;
      if (stored ? readStored() !== oldRaw : readStored() !== null) throw new Error("This vault changed elsewhere. Nothing was overwritten.");
      localStorage.setItem(PASSWORD_STORAGE_KEY, raw); setStored(raw); setImportRaw(""); setVault({ data: recovered.data, key, salt, iterations: PASSWORD_ITERATIONS, raw, recovery });
      setRecovering(false); setRecoveryCode(""); setMaster(""); setConfirm(""); setNotice("Master password reset. Keep your recovery code and make a new encrypted backup.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Couldn't recover the vault."); }
    finally { working.current = false; setBusy(false); }
  };
  const finishMasterChange = (previous: Unlocked, next: Unlocked) => {
    if (session.current !== previous || document.hidden) throw new Error("The vault was locked. Unlock it before changing the master password.");
    if (readStored() !== previous.raw) throw new Error("This vault changed elsewhere. Nothing was overwritten; lock and unlock to reload.");
    localStorage.setItem(PASSWORD_STORAGE_KEY, next.raw);
    session.current = next; setStored(next.raw); setVault(next); setChangeOpen(false); setChangeCandidate(null);
    setOldMaster(""); setNewMaster(""); setNewConfirm(""); setSavedNewCode(false); setError("");
    setNotice("Master password changed. Make a new encrypted backup; older backups retain their previous password and recovery code.");
  };
  const changeMaster = async (event: FormEvent) => {
    event.preventDefault(); if (!vault || working.current) return;
    working.current = true; setBusy(true); setError("");
    const previous = vault, started = generation.current, changeStarted = ++changeGeneration.current;
    try {
      if (newMaster.length < 12 || newMaster !== newConfirm) throw new Error("Use matching new master passwords of at least 12 characters.");
      const storage = readPasswordStorage(previous.raw); if (!storage) throw new Error("Unknown or damaged vault; nothing was changed.");
      const verified = await unlockPasswordData(storage.envelope, oldMaster);
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const wrappingKey = await derivePasswordKey(newMaster, salt, PASSWORD_ITERATIONS, true);
      const envelope = await encryptPasswordData(verified.data, wrappingKey, salt);
      // A recovery record wraps the old key, so a master change must offer a
      // fresh code rather than silently leaving recovery broken.
      const code = storage.recovery ? generateRecoveryCode() : "";
      const recovery = code ? await makeRecoveryRecord(wrappingKey, salt, code) : null;
      const key = await derivePasswordKey(newMaster, salt, PASSWORD_ITERATIONS);
      const next: Unlocked = { data: verified.data, key, salt, iterations: PASSWORD_ITERATIONS, raw: packPasswordStorage(envelope, recovery), recovery };
      if (started !== generation.current || changeStarted !== changeGeneration.current || session.current !== previous || document.hidden) return;
      if (readStored() !== previous.raw) throw new Error("This vault changed elsewhere. Nothing was overwritten; lock and unlock to reload.");
      setOldMaster(""); setNewMaster(""); setNewConfirm("");
      if (code) { setChangeCandidate({ previous, next, code }); setSavedNewCode(false); }
      else finishMasterChange(previous, next);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Couldn't change the master password."); }
    finally { working.current = false; setBusy(false); }
  };
  const eraseForgottenVault = (event: FormEvent) => {
    event.preventDefault(); if (!stored || resetConfirmation !== "DELETE" || working.current) return;
    setError("");
    try {
      // No asynchronous work is allowed between the recheck and removal.
      if (readStored() !== stored) throw new Error("This vault changed elsewhere. Nothing was deleted; reload before trying again.");
      localStorage.removeItem(PASSWORD_STORAGE_KEY);
      setStored(null); setResetting(false); setResetConfirmation(""); setRecovering(false); setImportRaw(""); setMaster(""); setConfirm(""); setRecoveryCode("");
      setNotice("The device vault was erased. You can create a new vault or import an encrypted backup.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Couldn't erase the device vault."); }
  };
  const saveEntry = async (event: FormEvent) => {
    event.preventDefault(); if (!draft || !vault) return;
    const name = draft.name.trim(), website = draft.website.trim();
    if (!name || (website && !passwordWebsite(website))) { setError("Enter a name and a valid website address."); return; }
    const item = { ...draft, name, website: website ? passwordWebsite(website)! : "" };
    const entries = vault.data.entries.some((entry) => entry.id === item.id) ? vault.data.entries.map((entry) => entry.id === item.id ? item : entry) : [...vault.data.entries, item];
    if (await save({ ...vault.data, entries })) { setDraft(null); setRevealed(false); setNotice("Saved to your encrypted vault."); }
  };
  const copy = async (value: string) => { try { await navigator.clipboard.writeText(value); setNotice("Copied. Your system clipboard may retain this until you replace it."); } catch { setNotice("Couldn't access the clipboard; select and copy it instead."); } };
  const exportVault = () => { if (!vault) return; const url = URL.createObjectURL(new Blob([vault.raw], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = "comet-passwords-encrypted.json"; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); };
  return <section className="passwords-card" aria-labelledby="passwords-title"><div className="passwords-heading"><span className="explore-heading-icon"><KeyRound size={20} /></span><div><span className="section-eyebrow">PRIVATE BY DESIGN</span><h1 id="passwords-title">Passwords</h1><p>Keep your logins together on this device.</p></div>{vault && <div className="passwords-actions"><button type="button" className="secondary-button" onClick={exportVault}><Download size={15} /> Backup</button><button type="button" className="secondary-button" onClick={() => { changeGeneration.current++; setChangeOpen(false); setChangeCandidate(null); setSetupOpen(true); setError(""); }}>{vault.recovery ? "Replace recovery code" : "Set up recovery"}</button><button type="button" className="secondary-button" onClick={() => { recoveryGeneration.current++; setSetupOpen(false); setRecoveryCandidate(null); setChangeOpen(true); setError(""); }}>Change master password</button><button type="button" className="secondary-button" onClick={lock}><Lock size={15} /> Lock</button><button type="button" className="primary-button" onClick={() => { setDraft(emptyEntry()); setRevealed(false); setError(""); }}><Plus size={16} /> New password</button></div>}</div>
    {stored === undefined ? <div className="dialog-error" role="alert">Device storage isn't available. Your vault has not been changed.</div> : !vault ? resetting ? <form className="password-unlock" onSubmit={eraseForgottenVault}>
      <span className="password-lock-icon"><Trash2 size={26} /></span><h2>Erase this password vault?</h2>
      <p className="password-warning">This permanently deletes every password stored in this device vault. This cannot be undone. Encrypted backups elsewhere are not deleted.</p>
      <label>Type DELETE to confirm<input aria-label="Type DELETE to confirm" autoComplete="off" spellCheck={false} value={resetConfirmation} onChange={(event) => setResetConfirmation(event.target.value)} /></label>
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <button type="submit" className="password-delete" disabled={resetConfirmation !== "DELETE"}>Erase all passwords</button>
      <button type="button" className="password-import" onClick={() => { setResetting(false); setResetConfirmation(""); setError(""); }}>Cancel</button>
    </form> : <form className="password-unlock" onSubmit={(event) => void (recovering ? resetWithRecovery(event) : authenticate(event))}><span className="password-lock-icon"><ShieldCheck size={28} /></span><h2>{recovering ? "Recover your vault" : stored ? "Unlock your vault" : importRaw ? "Unlock backup" : "Create your vault"}</h2><p>{recovering ? "Enter your recovery code and choose a new master password. Your passwords remain on this device." : stored ? "Enter your master password. Your vault locks when you leave or after five minutes of inactivity." : importRaw ? "Enter the backup's master password to verify and import it." : "Choose a strong master password. Only encrypted data is stored on this device."}</p>{!stored && !importRaw && <p className="password-warning">After creating the vault, set up a recovery code and save an encrypted backup. If both your master password and recovery code are lost, Comet cannot decrypt your passwords.</p>}
      {recovering && <label>Recovery code<input autoComplete="off" spellCheck={false} value={recoveryCode} onChange={(event) => setRecoveryCode(event.target.value)} required /></label>}
      <label>{recovering ? "New master password" : "Master password"}<input type="password" autoComplete={recovering || (!stored && !importRaw) ? "new-password" : "current-password"} value={master} onChange={(event) => setMaster(event.target.value)} minLength={recovering || (!stored && !importRaw) ? 12 : 1} required /></label>{(recovering || (!stored && !importRaw)) && <label>Confirm master password<input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} minLength={12} required /></label>}{error && <p className="dialog-error" role="alert">{error}</p>}<button className="primary-button" type="submit" disabled={busy}>{busy ? "Working…" : recovering ? "Reset master password" : stored || importRaw ? "Unlock" : "Create encrypted vault"}</button>
      {(stored || importRaw) && sourceStorage?.recovery && <button type="button" className="password-import" onClick={() => { setRecovering(!recovering); setMaster(""); setConfirm(""); setRecoveryCode(""); setError(""); }}>{recovering ? "Use master password instead" : "Forgot master password? Use recovery code"}</button>}
      {stored && <button type="button" className="password-import" onClick={() => { setResetting(true); setResetConfirmation(""); setError(""); }}>Forgot both? Erase this vault</button>}
      {notice && <p className="password-notice" role="status">{notice}</p>}
      {!stored && <><button type="button" className="password-import" onClick={() => importFile.current?.click()}>Import encrypted backup</button><input type="file" ref={importFile} hidden accept="application/json,.json" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (!file) return; if (file.size > 8_002_000) { setError("That backup is too large."); return; } void file.text().then((value) => { if (!readPasswordStorage(value)) throw new Error(); setImportRaw(value); setError(""); }).catch(() => setError("Couldn't read that backup.")); }} />{importRaw && <button type="button" className="password-import" onClick={() => { setImportRaw(""); setRecovering(false); }}>Cancel import</button>}</>}</form> : <div className="password-content">
      {changeOpen && <div className="password-recovery-panel"><div className="password-form-heading"><h2>Change master password</h2><button type="button" aria-label="Close master password change" onClick={() => { changeGeneration.current++; setChangeOpen(false); setChangeCandidate(null); setOldMaster(""); setNewMaster(""); setNewConfirm(""); setSavedNewCode(false); setError(""); }}><X size={16} /></button></div>
        {changeCandidate ? <><p>Save your new recovery code before continuing. The previous code will no longer unlock this device vault; older backups still use their original code.</p><code>{changeCandidate.code}</code><button type="button" className="secondary-button" onClick={() => void copy(changeCandidate.code)}><Copy size={15} /> Copy code</button><label><input type="checkbox" checked={savedNewCode} onChange={(event) => setSavedNewCode(event.target.checked)} /> I saved the new recovery code.</label><button type="button" className="primary-button" disabled={!savedNewCode} onClick={() => { try { finishMasterChange(changeCandidate.previous, changeCandidate.next); } catch (reason) { setError(reason instanceof Error ? reason.message : "Couldn't change the password."); } }}>Confirm master password change</button></> : <form onSubmit={(event) => void changeMaster(event)}><p>Enter the current master password and choose a new one. Your saved passwords stay in the vault.</p><label>Current master password<input type="password" autoComplete="current-password" value={oldMaster} onChange={(event) => setOldMaster(event.target.value)} required /></label><label>New master password<input type="password" autoComplete="new-password" minLength={12} value={newMaster} onChange={(event) => setNewMaster(event.target.value)} required /></label><label>Confirm new master password<input type="password" autoComplete="new-password" minLength={12} value={newConfirm} onChange={(event) => setNewConfirm(event.target.value)} required /></label><button type="submit" className="primary-button" disabled={busy}>{busy ? "Working…" : "Change password"}</button></form>}
      </div>}
      {setupOpen && <div className="password-recovery-panel"><div className="password-form-heading"><h2>Recovery code</h2><button type="button" aria-label="Close recovery setup" onClick={() => { recoveryGeneration.current++; setSetupOpen(false); setRecoveryCandidate(null); setSetupMaster(""); setSavedCode(false); }}><X size={16} /></button></div>{recoveryCandidate ? <><p>Save this code somewhere safe. Anyone with the code and an encrypted backup can unlock your passwords. It is shown only now and is never stored by Comet.</p><code>{recoveryCandidate.code}</code><button type="button" className="secondary-button" onClick={() => void copy(recoveryCandidate.code)}><Copy size={15} /> Copy code</button><label><input type="checkbox" checked={savedCode} onChange={(event) => setSavedCode(event.target.checked)} /> I saved the recovery code somewhere safe.</label><button type="button" className="primary-button" disabled={!savedCode} onClick={confirmRecoverySetup}>Enable recovery</button><small>Replacing a code does not change old backups. Keep their old code, or make a fresh backup.</small></> : <form onSubmit={(event) => void beginRecoverySetup(event)}><p>Confirm your master password to create a recovery code. Save the code separately from your device and encrypted backup.</p><label>Master password<input type="password" autoComplete="current-password" value={setupMaster} onChange={(event) => setSetupMaster(event.target.value)} required /></label><button type="submit" className="primary-button" disabled={busy}>{busy ? "Working…" : "Create recovery code"}</button></form>}</div>}
      <div className="password-list-tools"><input aria-label="Search passwords" placeholder="Search passwords…" value={query} onChange={(event) => setQuery(event.target.value)} /><label><input type="checkbox" checked={icons} onChange={(event) => { const enabled = event.target.checked; setIcons(enabled); try { localStorage.setItem(ICONS_KEY, String(enabled)); } catch { setNotice("The icon setting will last only until you leave this view."); } }} /> Load site icons</label></div><p className="password-icon-note">Site icons load automatically. Google receives website domains, not usernames or passwords; you can turn icons off here.</p>
      {error && <div className="dialog-error" role="alert">{error}</div>}{notice && <p className="password-notice" role="status">{notice}</p>}
      {draft ? <form className="password-form" onSubmit={(event) => void saveEntry(event)}><div className="password-form-heading"><h2>{vault.data.entries.some((entry) => entry.id === draft.id) ? "Edit password" : "New password"}</h2><button type="button" aria-label="Cancel password edit" onClick={() => { setDraft(null); setError(""); setRevealed(false); }}><X size={16} /></button></div><label>Name<input required maxLength={200} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="e.g. Example" /></label><label>Website <small>optional</small><input maxLength={2048} value={draft.website} onChange={(event) => setDraft({ ...draft, website: event.target.value })} placeholder="example.com" /></label><label>Username or email<input maxLength={500} autoComplete="off" value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} /></label><label>Password<div className="password-field"><input type={revealed ? "text" : "password"} autoComplete="new-password" maxLength={1000} value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} /><button type="button" aria-label={revealed ? "Hide password" : "Show password"} onClick={() => setRevealed(!revealed)}>{revealed ? <EyeOff size={16} /> : <Eye size={16} />}</button><button type="button" aria-label="Generate password" title="Generate password" onClick={() => setDraft({ ...draft, password: makePassword() })}><RefreshCw size={15} /></button></div></label><label>Notes <small>optional</small><textarea maxLength={5000} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label><div className="password-form-actions"><button type="button" className="secondary-button" onClick={() => { setDraft(null); setError(""); }}>Cancel</button><button type="submit" className="primary-button" disabled={busy}>Save</button></div></form> : <div className="password-list">{vault.data.entries.filter((entry) => `${entry.name} ${entry.username} ${entry.website}`.toLowerCase().includes(query.toLowerCase())).map((entry) => <article className="password-item" key={entry.id}><div className="password-item-icon">{icons ? <SiteIcon website={entry.website} /> : <Globe size={19} />}</div><button type="button" className="password-item-main" onClick={() => { setDraft({ ...entry }); setError(""); setNotice(""); }}><strong>{entry.name}</strong><span>{entry.username || entry.website || "No username"}</span></button><button type="button" className="icon-button" title="Copy password" aria-label={`Copy password for ${entry.name}`} onClick={() => void copy(entry.password)}><Copy size={16} /></button>{deleting === entry.id ? <><button type="button" className="password-delete" disabled={busy} onClick={() => void save({ ...vault.data, entries: vault.data.entries.filter((item) => item.id !== entry.id) }).then((ok) => { if (ok) setDeleting(""); })}>Delete</button><button type="button" className="icon-button" aria-label="Cancel deleting password" onClick={() => setDeleting("")}><X size={15} /></button></> : <button type="button" className="icon-button" aria-label={`Delete ${entry.name}`} onClick={() => setDeleting(entry.id)}><Trash2 size={16} /></button>}</article>)}{!vault.data.entries.length && <div className="password-empty"><KeyRound size={25} /><strong>Your vault is ready</strong><span>Add your first login whenever you like.</span></div>}</div>}
    </div>}
  </section>;
}
