import { ArrowLeft, Check, FolderOpen, Keyboard, Monitor, Moon, RotateCcw, Sun } from "lucide-react";
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
  { value: "dark", label: "Dark", description: "Easy on the eyes", icon: Moon },
  { value: "light", label: "Light", description: "A brighter space", icon: Sun },
  { value: "system", label: "System", description: "Match your device", icon: Monitor },
];

export function SettingsPage({ settings, persisted, isSample, modifier, onChange, onBack, onOpenVault }: SettingsPageProps) {
  return <section className="settings-page" aria-labelledby="settings-title">
    <button className="settings-back" type="button" onClick={onBack}><ArrowLeft size={16} /> Back to workspace</button>
    <div className="settings-header">
      <div><span className="section-eyebrow">YOUR SPACE, YOUR WAY</span><h1 id="settings-title">Settings</h1><p>A few little things to make Comet feel like yours.</p></div>
      <span className="settings-saved"><Check size={14} /> {persisted ? "Saved on this device" : "For this session only"}</span>
    </div>

    <div className="settings-layout">
      <div className="settings-main">
        <section className="settings-card" aria-labelledby="appearance-title">
          <div className="settings-card-heading"><div><h2 id="appearance-title">Appearance</h2><p>Set the mood for your workspace.</p></div><span className="settings-number">01</span></div>
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
          <label className="setting-row">
            <span className="setting-copy"><strong>Matterhorn background</strong><small>Show the mountain behind your workspace.</small></span>
            <input className="setting-toggle" type="checkbox" aria-label="Matterhorn background" checked={settings.showCover} onChange={(event) => onChange({ showCover: event.target.checked })} />
          </label>
        </section>

        <section className="settings-card" aria-labelledby="editor-settings-title">
          <div className="settings-card-heading"><div><h2 id="editor-settings-title">Editor</h2><p>Make a little more room to think.</p></div><span className="settings-number">02</span></div>
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
          <div className="settings-card-heading"><div><h2 id="workspace-settings-title">Workspace</h2><p>Keep your notes close, and yours alone.</p></div><span className="settings-number">03</span></div>
          <label className="setting-row">
            <span className="setting-copy"><strong>Reopen last workspace</strong><small>Return to your last local folder and note when Comet starts.</small></span>
            <input className="setting-toggle" type="checkbox" aria-label="Reopen last workspace" checked={settings.reopenWorkspace} onChange={(event) => onChange({ reopenWorkspace: event.target.checked })} />
          </label>
          <div className="setting-row">
            <span className="setting-copy"><strong>{isSample ? "Sample workspace" : "Local workspace"}</strong><small>{isSample ? "Your sample is separate from your local files." : "Files are stored in your folder on this device."}</small></span>
            <button type="button" className="secondary-button settings-open-folder" onClick={onOpenVault}><FolderOpen size={15} /> Open folder</button>
          </div>
        </section>
      </div>

      <aside className="settings-aside" aria-label="Settings information">
        <div className="settings-aside-card shortcut-card"><div className="settings-aside-icon"><Keyboard size={18} /></div><h3>Little shortcuts</h3><p>A few ways to move a little faster.</p><dl><div><dt>Go to path</dt><dd><kbd>{modifier} L</kbd></dd></div><div><dt>Search files</dt><dd><kbd>{modifier} K</kbd></dd></div><div><dt>New file</dt><dd><kbd>{modifier} N</kbd></dd></div><div><dt>Quick capture</dt><dd><kbd>{modifier} ⇧ K</kbd></dd></div></dl></div>
        <button className="reset-settings" type="button" onClick={() => onChange({ ...DEFAULT_SETTINGS })}><RotateCcw size={15} /> Reset preferences</button>
      </aside>
    </div>
  </section>;
}
