import { useState } from "react";
import { ArrowLeft, Check, FolderOpen, Gem, Keyboard, Monitor, Moon, RotateCcw, Sun } from "lucide-react";
import { keyboardShortcut, shortcutLabel, SHORTCUT_ACTIONS, type ShortcutAction } from "./utils/shortcuts";
import { DEFAULT_SETTINGS, type Settings, type ThemePreference } from "./utils/settings";

interface SettingsPageProps {
  settings: Settings;
  persisted: boolean;
  isSample: boolean;
  modifier: string;
  onChange: (patch: Partial<Settings>) => void;
  onBack: () => void;
  onOpenVault: () => void;
}

const themes: { value: ThemePreference; label: string; description: string; icon: typeof Moon }[] = [
  { value: "system", label: "System", description: "Match your device", icon: Monitor },
  { value: "dark", label: "Dark", description: "Easy on the eyes", icon: Moon },
  { value: "light", label: "Light", description: "A brighter space", icon: Sun },
  { value: "emerald", label: "Emerald", description: "A forest glow", icon: Gem },
  { value: "rubellite", label: "Rubellite", description: "A warm rose glow", icon: Gem },
  { value: "navy", label: "Navy", description: "A midnight blue", icon: Moon },
];

export function SettingsPage({ settings, persisted, isSample, modifier, onChange, onBack, onOpenVault }: SettingsPageProps) {
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [shortcutError, setShortcutError] = useState("");
  const mac = modifier === "⌘";
  return <section className="settings-page" aria-labelledby="settings-title">
    <button className="settings-back" type="button" onClick={onBack}><ArrowLeft size={16} /> Back to workspace</button>
    <div className="settings-header">
      <div><span className="section-eyebrow">YOUR SPACE, YOUR WAY</span><h1 id="settings-title">Settings</h1><p>A few little things to make Comet feel like yours.</p></div>
      <span className="settings-saved"><Check size={14} /> {persisted ? "Saved on this device" : "For this session only"}</span>
    </div>

    <div className="settings-layout">
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
          <label className="setting-row scale-setting">
            <span className="setting-copy"><strong>App scale</strong><small>Resize the whole interface.</small></span>
            <input type="range" aria-label="App scale" min="75" max="150" step="5" value={settings.interfaceScale} onChange={(event) => onChange({ interfaceScale: Number(event.target.value) })} /><output>{settings.interfaceScale}%</output>
          </label>
          <label className="setting-row scale-setting">
            <span className="setting-copy"><strong>Interface text scale</strong><small>Make labels and other text easier to read.</small></span>
            <input type="range" aria-label="Interface text scale" min="80" max="140" step="5" value={settings.textScale} onChange={(event) => onChange({ textScale: Number(event.target.value) })} /><output>{settings.textScale}%</output>
          </label>
        </section>

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
    </div>
  </section>;
}
