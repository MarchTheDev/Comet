import { useEffect, useRef, useState } from "react";
import { disable as disableAutostart, enable as enableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import { ArrowLeft, Check, FolderOpen, Gem, Keyboard, Monitor, Moon, RotateCcw, Sun } from "lucide-react";
import { keyboardShortcut, shortcutLabel, SHORTCUT_ACTIONS, type ShortcutAction } from "./utils/shortcuts";
import { GoogleSettings } from "./GoogleSettings";
import { UpdatesSettings } from "./UpdatesSettings";
import type { UpdateInfo } from "./utils/updates";
import { DEFAULT_SETTINGS, type Settings, type ThemePreference } from "./utils/settings";

interface SettingsPageProps {
  settings: Settings;
  persisted: boolean;
  isSample: boolean;
  vault?: string;
  onImported?: (path: string) => void;
  onSyncStart?: () => Promise<boolean>;
  onSyncEnd?: () => Promise<void>;
  modifier: string;
  desktop: boolean;
  trayAvailable: boolean;
  onChange: (patch: Partial<Settings>) => void;
  onBack: () => void;
  onOpenVault: () => void;
  section?: "general" | "updates" | "cloud";
  onSection?: (section: "general" | "updates" | "cloud") => void;
  version?: string;
  update?: UpdateInfo | null;
  updateStatus?: string;
  onCheckUpdate?: () => void;
  onInstallUpdate?: () => void;
  onUpdatePage?: () => void;
}

const themes: { value: ThemePreference; label: string; description: string; icon: typeof Moon }[] = [
  { value: "system", label: "System", description: "Match your device", icon: Monitor },
  { value: "dark", label: "Dark", description: "Easy on the eyes", icon: Moon },
  { value: "light", label: "Light", description: "A brighter space", icon: Sun },
  { value: "emerald", label: "Emerald", description: "A forest glow", icon: Gem },
  { value: "rubellite", label: "Rubellite", description: "A warm rose glow", icon: Gem },
  { value: "navy", label: "Navy", description: "A midnight blue", icon: Moon },
  { value: "0807-light", label: "0807 Light", description: "Soft paper & coral", icon: Sun },
  { value: "0807-dark", label: "0807 Dark", description: "Slate & coral", icon: Moon },
];

export function SettingsPage({ settings, persisted, isSample, vault = "", onImported = () => {}, onSyncStart, onSyncEnd, modifier, desktop, trayAvailable, onChange, onBack, onOpenVault, section = "general", onSection, version = "", update = null, updateStatus = "", onCheckUpdate = () => {}, onInstallUpdate = () => {}, onUpdatePage = () => {} }: SettingsPageProps) {
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [shortcutError, setShortcutError] = useState("");
  const mac = modifier === "⌘";
  return <section className="settings-page" aria-labelledby="settings-title">
    <button className="settings-back" type="button" onClick={onBack}><ArrowLeft size={16} /> Back to workspace</button>
    <div className="settings-header">
      <div><span className="section-eyebrow">YOUR SPACE, YOUR WAY</span><h1 id="settings-title">Settings</h1><p>A few little things to make Comet feel like yours.</p></div>
      <span className="settings-saved"><Check size={14} /> {persisted ? "Saved on this device" : "For this session only"}</span>
    </div>

    {onSection && <div className="settings-tabs" role="tablist" aria-label="Settings sections"><button type="button" role="tab" aria-selected={section === "general"} onClick={() => onSection("general")}>General</button><button type="button" role="tab" aria-selected={section === "updates"} onClick={() => onSection("updates")}>Updates{update && <span className="update-dot" />}</button><button type="button" role="tab" aria-selected={section === "cloud"} onClick={() => onSection("cloud")}>Cloud</button></div>}
    {section === "cloud" ? <GoogleSettings desktop={desktop} vault={vault} isSample={isSample} onImported={onImported} onSyncStart={onSyncStart} onSyncEnd={onSyncEnd} /> : section === "updates" ? <UpdatesSettings version={version} update={update} status={updateStatus} desktop={desktop} onCheck={onCheckUpdate} onInstall={onInstallUpdate} onPage={onUpdatePage} /> : <div className="settings-layout">
      <div className="settings-main">
        <section className="settings-card" aria-labelledby="appearance-title">
          <div className="settings-card-heading"><div><h2 id="appearance-title">Appearance</h2><p>Set the mood for your workspace.</p></div></div>
          <fieldset className="theme-fieldset">
            <legend>Theme</legend>
            <div className="theme-options">
              {themes.map(({ value, label, description, icon: Icon }) => <label key={value} className={`theme-option${settings.theme === value ? " selected" : ""}`}>
                <input type="radio" name="theme" value={value} checked={settings.theme === value} onChange={() => onChange({ theme: value })} />
                <span className={`theme-preview theme-preview-${value}`} aria-hidden="true"><span /><span /><span /></span>
                <span className="theme-option-bottom"><span className="theme-label"><Icon size={15} /><strong>{label}</strong></span>{settings.theme === value && <Check size={15} className="theme-check" />}</span>
                <small>{description}</small>
              </label>)}
            </div>
          </fieldset>
          <ScaleSetting label="App scale" description="Resize the whole interface." min={75} max={150} value={settings.interfaceScale} onCommit={(interfaceScale) => onChange({ interfaceScale })} />
          <ScaleSetting label="Interface text scale" description="Make labels and other text easier to read." min={65} max={140} value={settings.textScale} onCommit={(textScale) => onChange({ textScale })} />
        </section>

        <DesktopSettings desktop={desktop} trayAvailable={trayAvailable} settings={settings} onChange={onChange} />

        <section className="settings-card" aria-labelledby="editor-settings-title">
          <div className="settings-card-heading"><div><h2 id="editor-settings-title">Editor</h2><p>Make a little more room to think.</p></div></div>
          <label className="setting-row">
            <span className="setting-copy"><strong>Text size</strong><small>Adjust the size of your note text.</small></span>
            <select aria-label="Editor text size" value={settings.editorFontSize} onChange={(event) => onChange({ editorFontSize: Number(event.target.value) as Settings["editorFontSize"] })}>
              <option value={14}>Small</option><option value={16}>Medium</option><option value={18}>Large</option>
            </select>
          </label>
          <label className="setting-row">
            <span className="setting-copy"><strong>Spell check</strong><small>Highlight spelling mistakes while you write.</small></span>
            <input className="setting-toggle" type="checkbox" aria-label="Spell check" checked={settings.spellcheck} onChange={(event) => onChange({ spellcheck: event.target.checked })} />
          </label>
        </section>

        <section className="settings-card" aria-labelledby="workspace-settings-title">
          <div className="settings-card-heading"><div><h2 id="workspace-settings-title">Workspace</h2><p>Keep your notes close, and yours alone.</p></div></div>
          <label className="setting-row">
            <span className="setting-copy"><strong>Reopen last workspace</strong><small>Return to your last local folder and note when Comet starts.</small></span>
            <input className="setting-toggle" type="checkbox" aria-label="Reopen last workspace" checked={settings.reopenWorkspace} onChange={(event) => onChange({ reopenWorkspace: event.target.checked })} />
          </label>
          <label className="setting-row">
            <span className="setting-copy"><strong>To-do connection arrowheads</strong><small>Show an arrow at the end of each connection.</small></span>
            <input className="setting-toggle" type="checkbox" aria-label="To-do connection arrowheads" checked={settings.todoArrowheads} onChange={(event) => onChange({ todoArrowheads: event.target.checked })} />
          </label>
          <label className="setting-row">
            <span className="setting-copy"><strong>Find music covers automatically</strong><small>Sends a track's title and artist (or filename) to Apple's music catalog when artwork is missing.</small></span>
            <input className="setting-toggle" type="checkbox" aria-label="Find music covers automatically" checked={settings.autoCoverArt} onChange={(event) => onChange({ autoCoverArt: event.target.checked })} />
          </label>
          <div className="setting-row">
            <span className="setting-copy"><strong>{isSample ? "Sample workspace" : "Local workspace"}</strong><small>{isSample ? "Your sample is separate from your local files." : "Files are stored in your folder on this device."}</small></span>
            <button type="button" className="secondary-button settings-open-folder" onClick={onOpenVault}><FolderOpen size={15} /> Open folder</button>
          </div>
        </section>
      </div>

      <aside className="settings-aside" aria-label="Settings information">
        <div className="settings-aside-card shortcut-card"><div className="settings-aside-icon"><Keyboard size={18} /></div><h3>Keyboard shortcuts</h3><p>Choose an action, then press its new key combination. Escape cancels.</p>
          <dl>{(Object.entries(SHORTCUT_ACTIONS) as [ShortcutAction, string][]).map(([action, label]) => <div key={action}><dt>{label}</dt><dd><button type="button" className={recording === action ? "shortcut-edit recording" : "shortcut-edit"} aria-label={`Change ${label} shortcut`} onClick={() => { setRecording(action); setShortcutError(""); }} onKeyDown={(event) => {
            if (recording !== action) return;
            event.preventDefault(); event.stopPropagation();
            if (event.key === "Escape") { setRecording(null); setShortcutError(""); return; }
            const value = keyboardShortcut(event.nativeEvent, mac);
            if (!value || value.endsWith("+")) { setShortcutError("Use Ctrl, Command, or Alt with another key."); return; }
            const duplicate = (Object.entries(settings.shortcuts) as [ShortcutAction, string][]).find(([other, key]) => other !== action && key === value);
            if (duplicate) { setShortcutError(`Already used by ${SHORTCUT_ACTIONS[duplicate[0]]}.`); return; }
            onChange({ shortcuts: { ...settings.shortcuts, [action]: value } }); setRecording(null); setShortcutError("");
          }}>{recording === action ? "Press keys…" : shortcutLabel(settings.shortcuts[action], mac)}</button></dd></div>)}</dl>
          {shortcutError && <div className="dialog-error" role="alert">{shortcutError}</div>}
        </div>
        <button className="reset-settings" type="button" onClick={() => onChange({ ...DEFAULT_SETTINGS })}><RotateCcw size={15} /> Reset preferences</button>
      </aside>
    </div>}
  </section>;
}

/** Defer zoom/reflow until the pointer is released, so the slider stays under it. */
function ScaleSetting({ label, description, min, max, value, onCommit }: { label: string; description: string; min: number; max: number; value: number; onCommit: (value: number) => void }) {
  const [draft, setDraft] = useState(value);
  const dragging = useRef(false);
  const latest = useRef(value);
  useEffect(() => { if (!dragging.current) { latest.current = value; setDraft(value); } }, [value]);
  const finish = () => { if (dragging.current) { dragging.current = false; onCommit(latest.current); } };
  return <label className="setting-row scale-setting">
    <span className="setting-copy"><strong>{label}</strong><small>{description} Changes apply when you release the slider.</small></span>
    <input type="range" aria-label={label} min={min} max={max} step="5" value={draft}
      onPointerDown={() => { dragging.current = true; }} onPointerUp={finish} onPointerCancel={finish} onBlur={finish}
      onChange={(event) => { const next = Number(event.target.value); latest.current = next; setDraft(next); if (!dragging.current) onCommit(next); }} />
    <output>{draft}%</output>
  </label>;
}

function DesktopSettings({ desktop, trayAvailable, settings, onChange }: Pick<SettingsPageProps, "desktop" | "trayAvailable" | "settings" | "onChange">) {
  const [autostart, setAutostart] = useState(false);
  const [checking, setChecking] = useState(desktop);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void isAutostartEnabled().then((enabled) => { if (active) setAutostart(enabled); }).catch((reason: unknown) => { if (active) setError(`Couldn't check startup: ${String(reason)}`); }).finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [desktop]);
  const changeAutostart = async (enabled: boolean) => {
    setChecking(true); setError("");
    try { if (enabled) await enableAutostart(); else await disableAutostart(); setAutostart(enabled); }
    catch (reason) { setError(`Couldn't change startup: ${String(reason)}`); }
    finally { setChecking(false); }
  };
  return <section className="settings-card" aria-labelledby="desktop-settings-title">
    <div className="settings-card-heading"><div><h2 id="desktop-settings-title">Startup &amp; tray</h2><p>{desktop ? "Choose how Comet starts and closes on this device." : "These options are available in the desktop app."}</p></div></div>
    <label className="setting-row"><span className="setting-copy"><strong>Launch at system login</strong><small>Start Comet when you sign in.</small></span><input className="setting-toggle" type="checkbox" aria-label="Launch at system login" disabled={!desktop || checking} checked={autostart} onChange={(event) => void changeAutostart(event.target.checked)} /></label>
    <label className="setting-row"><span className="setting-copy"><strong>Start in the system tray</strong><small>Keep the window hidden on launch. Use the tray icon to open it.</small></span><input className="setting-toggle" type="checkbox" aria-label="Start in the system tray" disabled={!desktop || !trayAvailable} checked={settings.startInTray} onChange={(event) => onChange({ startInTray: event.target.checked })} /></label>
    <label className="setting-row"><span className="setting-copy"><strong>Close to the system tray</strong><small>Closing the window keeps Comet running. Quit from the tray menu.</small></span><input className="setting-toggle" type="checkbox" aria-label="Close to the system tray" disabled={!desktop || !trayAvailable} checked={settings.closeToTray} onChange={(event) => onChange({ closeToTray: event.target.checked })} /></label>
    {desktop && !trayAvailable && <p className="desktop-settings-note">The system tray isn't available; the window will remain accessible.</p>}
    {error && <p className="dialog-error" role="alert">{error}</p>}
  </section>;
}
