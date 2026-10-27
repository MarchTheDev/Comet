import { DEFAULT_SHORTCUTS, readShortcuts, type Shortcuts } from "./shortcuts";

export type ThemePreference = "dark" | "light" | "system" | "emerald" | "rubellite" | "navy";
export type EditorFontSize = 14 | 16 | 18;

export interface Settings {
  theme: ThemePreference;
  shortcuts: Shortcuts;
  editorFontSize: EditorFontSize;
  interfaceScale: number;
  textScale: number;
  todoArrowheads: boolean;
  autoCoverArt: boolean;
  spellcheck: boolean;
  reopenWorkspace: boolean;
}

export const SETTINGS_KEY = "comet:settings:v1";
export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  shortcuts: { ...DEFAULT_SHORTCUTS },
  editorFontSize: 16,
  interfaceScale: 100,
  textScale: 100,
  todoArrowheads: false,
  autoCoverArt: true,
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
      theme: (["light", "system", "dark", "emerald", "rubellite", "navy"] as unknown[]).includes(value.theme) ? value.theme as ThemePreference : DEFAULT_SETTINGS.theme,
      shortcuts: readShortcuts(value.shortcuts),
      editorFontSize: value.editorFontSize === 14 || value.editorFontSize === 16 || value.editorFontSize === 18 ? value.editorFontSize : DEFAULT_SETTINGS.editorFontSize,
      interfaceScale: typeof value.interfaceScale === "number" && Number.isFinite(value.interfaceScale) && value.interfaceScale >= 75 && value.interfaceScale <= 150 ? value.interfaceScale : DEFAULT_SETTINGS.interfaceScale,
      textScale: typeof value.textScale === "number" && Number.isFinite(value.textScale) && value.textScale >= 80 && value.textScale <= 140 ? value.textScale : DEFAULT_SETTINGS.textScale,
      todoArrowheads: typeof value.todoArrowheads === "boolean" ? value.todoArrowheads : DEFAULT_SETTINGS.todoArrowheads,
      autoCoverArt: typeof value.autoCoverArt === "boolean" ? value.autoCoverArt : DEFAULT_SETTINGS.autoCoverArt,
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
