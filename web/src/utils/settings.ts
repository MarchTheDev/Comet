export type ThemePreference = "dark" | "light" | "system";
export type EditorFontSize = 14 | 16 | 18;

export interface Settings {
  theme: ThemePreference;
  showCover: boolean;
  editorFontSize: EditorFontSize;
  spellcheck: boolean;
  reopenWorkspace: boolean;
}

export const SETTINGS_KEY = "comet:settings:v1";
export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  showCover: true,
  editorFontSize: 16,
  spellcheck: true,
  reopenWorkspace: true,
};

type SettingsStorage = Pick<Storage, "getItem" | "setItem">;

function storage(): SettingsStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/** Preferences are optional; invalid or unavailable storage must never block notes. */
export function readSettings(store: SettingsStorage | undefined = storage()): Settings {
  try {
    const raw = store?.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...DEFAULT_SETTINGS };
    const value = parsed as Partial<Settings>;
    return {
      theme: value.theme === "light" || value.theme === "system" || value.theme === "dark" ? value.theme : DEFAULT_SETTINGS.theme,
      showCover: typeof value.showCover === "boolean" ? value.showCover : DEFAULT_SETTINGS.showCover,
      editorFontSize: value.editorFontSize === 14 || value.editorFontSize === 16 || value.editorFontSize === 18 ? value.editorFontSize : DEFAULT_SETTINGS.editorFontSize,
      spellcheck: typeof value.spellcheck === "boolean" ? value.spellcheck : DEFAULT_SETTINGS.spellcheck,
      reopenWorkspace: typeof value.reopenWorkspace === "boolean" ? value.reopenWorkspace : DEFAULT_SETTINGS.reopenWorkspace,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Returns whether preferences could be saved, so the UI can describe temporary settings. */
export function saveSettings(settings: Settings, store: SettingsStorage | undefined = storage()): boolean {
  try {
    if (!store) return false;
    store.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}
