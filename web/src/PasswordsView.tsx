import { useEffect, useRef, useState, type FormEvent } from "react";
import { Copy, Download, Eye, EyeOff, Globe, KeyRound, Lock, Plus, RefreshCw, ShieldCheck, Trash2, X } from "lucide-react";
import { derivePasswordKey, encryptPasswordData, faviconUrl, makePassword, PASSWORD_ITERATIONS, PASSWORD_STORAGE_KEY, passwordWebsite, unlockPasswordData, type PasswordData, type PasswordEntry } from "./utils/passwords";

const emptyEntry = (): PasswordEntry => ({ id: crypto.randomUUID(), name: "", website: "", username: "", password: "", notes: "" });
type Unlocked = { data: PasswordData; key: CryptoKey; salt: Uint8Array; iterations: number; raw: string };
function readStored(): string | null { return localStorage.getItem(PASSWORD_STORAGE_KEY); }

/** Encrypted, device-local vault. Never silently replaces another window's changes. */
export function PasswordsView() {
  const [stored, setStored] = useState<string | null | undefined>(() => { try { return readStored(); } catch { return undefined; } });
  const [vault, setVault] = useState<Unlocked | null>(null), [master, setMaster] = useState(""), [confirm, setConfirm] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [query, setQuery] = useState(""), [draft, setDraft] = useState<PasswordEntry | null>(null), [revealed, setRevealed] = useState(false), [deleting, setDeleting] = useState(""), [icons, setIcons] = useState(false), [importRaw, setImportRaw] = useState("");
  const working = useRef(false), importFile = useRef<HTMLInputElement>(null), session = useRef(vault); session.current = vault;
  const lock = () => { session.current = null; setVault(null); setDraft(null); setRevealed(false); setMaster(""); setConfirm(""); setError(""); setNotice(""); };
  useEffect(() => {
    if (!vault) return;
    let timer = window.setTimeout(lock, 5 * 60_000);
    const activity = () => { window.clearTimeout(timer); timer = window.setTimeout(lock, 5 * 60_000); };
    const visibility = () => { if (document.hidden) lock(); };
    window.addEventListener("pointerdown", activity); window.addEventListener("keydown", activity); document.addEventListener("visibilitychange", visibility);
    return () => { window.clearTimeout(timer); window.removeEventListener("pointerdown", activity); window.removeEventListener("keydown", activity); document.removeEventListener("visibilitychange", visibility); };
  }, [Boolean(vault)]); // A new save must not reset the inactivity timer.
  const authenticate = async (event: FormEvent) => {
    event.preventDefault(); if (working.current || stored === undefined) return; working.current = true; setBusy(true); setError("");
    try {
      if (stored || importRaw) {
        const raw = stored || importRaw, result = await unlockPasswordData(raw, master);
        if (!stored) { if (readStored() !== null) throw new Error("A vault already exists on this device. It was not overwritten."); localStorage.setItem(PASSWORD_STORAGE_KEY, raw); setStored(raw); setImportRaw(""); }
        setVault({ ...result, raw });
      } else {
        if (master.length < 12) throw new Error("Use a master password of at least 12 characters.");
        if (master !== confirm) throw new Error("The master passwords don't match.");
        if (readStored() !== null) throw new Error("A vault already exists on this device. Reload to unlock it.");
        const salt = crypto.getRandomValues(new Uint8Array(16)), key = await derivePasswordKey(master, salt);
        const data: PasswordData = { format: "comet-passwords-data", version: 1, entries: [] }, raw = await encryptPasswordData(data, key, salt);
        if (readStored() !== null) throw new Error("A vault was created elsewhere; it wasn't overwritten.");
        localStorage.setItem(PASSWORD_STORAGE_KEY, raw); setStored(raw); setVault({ data, key, salt, iterations: PASSWORD_ITERATIONS, raw });
      }
      setMaster(""); setConfirm("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Couldn't unlock the vault."); }
    finally { working.current = false; setBusy(false); }
  };
  const save = async (data: PasswordData): Promise<boolean> => {
    if (!vault || working.current) return false; working.current = true; setBusy(true); setError("");
    try {
      const raw = await encryptPasswordData(data, vault.key, vault.salt, vault.iterations);
      if (session.current !== vault) throw new Error("The vault was locked while saving. Please unlock it and try again.");
      if (readStored() !== vault.raw) throw new Error("This vault changed elsewhere. Your edits weren't saved; lock and unlock it to reload.");
      localStorage.setItem(PASSWORD_STORAGE_KEY, raw); setStored(raw); setVault({ ...vault, data, raw }); return true;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Couldn't save. Your edit is still open."); return false; }
    finally { working.current = false; setBusy(false); }
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
  return <section className="passwords-card" aria-labelledby="passwords-title"><div className="passwords-heading"><span className="explore-heading-icon"><KeyRound size={20} /></span><div><span className="section-eyebrow">PRIVATE BY DESIGN</span><h1 id="passwords-title">Passwords</h1><p>Keep your logins together on this device.</p></div>{vault && <div className="passwords-actions"><button type="button" className="secondary-button" onClick={exportVault}><Download size={15} /> Backup</button><button type="button" className="secondary-button" onClick={lock}><Lock size={15} /> Lock</button><button type="button" className="primary-button" onClick={() => { setDraft(emptyEntry()); setRevealed(false); setError(""); }}><Plus size={16} /> New password</button></div>}</div>
    {stored === undefined ? <div className="dialog-error" role="alert">Device storage isn't available. Your vault has not been changed.</div> : !vault ? <form className="password-unlock" onSubmit={(event) => void authenticate(event)}><span className="password-lock-icon"><ShieldCheck size={28} /></span><h2>{stored ? "Unlock your vault" : importRaw ? "Unlock backup" : "Create your vault"}</h2><p>{stored ? "Enter your master password. Your vault locks when you leave or after five minutes of inactivity." : importRaw ? "Enter the backup's master password to verify and import it." : "Choose a strong master password. Only encrypted data is stored on this device."}</p>{!stored && !importRaw && <p className="password-warning">There is no password recovery. If you forget it, your saved passwords cannot be decrypted. Export an encrypted backup after setup.</p>}<label>Master password<input type="password" autoComplete={stored || importRaw ? "current-password" : "new-password"} value={master} onChange={(event) => setMaster(event.target.value)} minLength={stored || importRaw ? 1 : 12} required /></label>{!stored && !importRaw && <label>Confirm master password<input type="password" autoComplete="new-password" value={confirm} onChange={(event) => setConfirm(event.target.value)} minLength={12} required /></label>}{error && <p className="dialog-error" role="alert">{error}</p>}<button className="primary-button" type="submit" disabled={busy}>{busy ? "Working…" : stored || importRaw ? "Unlock" : "Create encrypted vault"}</button>{!stored && <><button type="button" className="password-import" onClick={() => importFile.current?.click()}>Import encrypted backup</button><input type="file" ref={importFile} hidden accept="application/json,.json" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (!file) return; if (file.size > 8_000_000) { setError("That backup is too large."); return; } void file.text().then((value) => { setImportRaw(value); setError(""); }).catch(() => setError("Couldn't read that backup.")); }} />{importRaw && <button type="button" className="password-import" onClick={() => setImportRaw("")}>Cancel import</button>}</>}</form> : <div className="password-content">
      <div className="password-list-tools"><input aria-label="Search passwords" placeholder="Search passwords…" value={query} onChange={(event) => setQuery(event.target.value)} /><label><input type="checkbox" checked={icons} onChange={(event) => setIcons(event.target.checked)} /> Load site icons</label></div><p className="password-icon-note">Site icons are optional. Enabling them sends website domains—not usernames or passwords—to Google's favicon service.</p>
      {error && <div className="dialog-error" role="alert">{error}</div>}{notice && <p className="password-notice" role="status">{notice}</p>}
      {draft ? <form className="password-form" onSubmit={(event) => void saveEntry(event)}><div className="password-form-heading"><h2>{vault.data.entries.some((entry) => entry.id === draft.id) ? "Edit password" : "New password"}</h2><button type="button" aria-label="Cancel password edit" onClick={() => { setDraft(null); setError(""); setRevealed(false); }}><X size={16} /></button></div><label>Name<input required maxLength={200} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="e.g. Example" /></label><label>Website <small>optional</small><input maxLength={2048} value={draft.website} onChange={(event) => setDraft({ ...draft, website: event.target.value })} placeholder="example.com" /></label><label>Username or email<input maxLength={500} autoComplete="off" value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} /></label><label>Password<div className="password-field"><input type={revealed ? "text" : "password"} autoComplete="new-password" maxLength={1000} value={draft.password} onChange={(event) => setDraft({ ...draft, password: event.target.value })} /><button type="button" aria-label={revealed ? "Hide password" : "Show password"} onClick={() => setRevealed(!revealed)}>{revealed ? <EyeOff size={16} /> : <Eye size={16} />}</button><button type="button" aria-label="Generate password" title="Generate password" onClick={() => setDraft({ ...draft, password: makePassword() })}><RefreshCw size={15} /></button></div></label><label>Notes <small>optional</small><textarea maxLength={5000} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label><div className="password-form-actions"><button type="button" className="secondary-button" onClick={() => { setDraft(null); setError(""); }}>Cancel</button><button type="submit" className="primary-button" disabled={busy}>Save</button></div></form> : <div className="password-list">{vault.data.entries.filter((entry) => `${entry.name} ${entry.username} ${entry.website}`.toLowerCase().includes(query.toLowerCase())).map((entry) => <article className="password-item" key={entry.id}><div className="password-item-icon">{icons && faviconUrl(entry.website) ? <img src={faviconUrl(entry.website)!} referrerPolicy="no-referrer" alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} /> : <Globe size={19} />}</div><button type="button" className="password-item-main" onClick={() => { setDraft({ ...entry }); setError(""); setNotice(""); }}><strong>{entry.name}</strong><span>{entry.username || entry.website || "No username"}</span></button><button type="button" className="icon-button" title="Copy password" aria-label={`Copy password for ${entry.name}`} onClick={() => void copy(entry.password)}><Copy size={16} /></button>{deleting === entry.id ? <><button type="button" className="password-delete" disabled={busy} onClick={() => void save({ ...vault.data, entries: vault.data.entries.filter((item) => item.id !== entry.id) }).then((ok) => { if (ok) setDeleting(""); })}>Delete</button><button type="button" className="icon-button" aria-label="Cancel deleting password" onClick={() => setDeleting("")}><X size={15} /></button></> : <button type="button" className="icon-button" aria-label={`Delete ${entry.name}`} onClick={() => setDeleting(entry.id)}><Trash2 size={16} /></button>}</article>)}{!vault.data.entries.length && <div className="password-empty"><KeyRound size={25} /><strong>Your vault is ready</strong><span>Add your first login whenever you like.</span></div>}</div>}
    </div>}
    <p className="password-security-note">Encrypted with AES-256-GCM and a master-password-derived key. This is not a substitute for an independently audited password manager; no autofill or cloud sync is provided.</p>
  </section>;
}
