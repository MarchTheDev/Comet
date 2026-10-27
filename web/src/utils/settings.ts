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
  startInTray: boolean;
  closeToTray: boolean;
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
  startInTray: false,
  closeToTray: false,
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
    const value = parsed as Partial<Settings> & { scaleVersion?: number };
    // Before v2, 120% was the new 100%. Preserve deliberately chosen
    // non-default sizes approximately; the old default adopts the new one.
    const oldTextScale = typeof value.textScale === "number" && Number.isFinite(value.textScale) && value.textScale >= 80 && value.textScale <= 140 ? value.textScale : 100;
    const textScale = value.scaleVersion === 2
      ? (typeof value.textScale === "number" && Number.isFinite(value.textScale) && value.textScale >= 65 && value.textScale <= 140 ? value.textScale : 100)
      : oldTextScale === 100 ? 100 : Math.max(65, Math.min(140, Math.round(oldTextScale / 1.2 / 5) * 5));
    return {
      theme: (["light", "system", "dark", "emerald", "rubellite", "navy"] as unknown[]).includes(value.theme) ? value.theme as ThemePreference : DEFAULT_SETTINGS.theme,
      shortcuts: readShortcuts(value.shortcuts),
      editorFontSize: value.editorFontSize === 14 || value.editorFontSize === 16 || value.editorFontSize === 18 ? value.editorFontSize : DEFAULT_SETTINGS.editorFontSize,
      interfaceScale: typeof value.interfaceScale === "number" && Number.isFinite(value.interfaceScale) && value.interfaceScale >= 75 && value.interfaceScale <= 150 ? value.interfaceScale : DEFAULT_SETTINGS.interfaceScale,
      textScale,
      todoArrowheads: typeof value.todoArrowheads === "boolean" ? value.todoArrowheads : DEFAULT_SETTINGS.todoArrowheads,
      autoCoverArt: typeof value.autoCoverArt === "boolean" ? value.autoCoverArt : DEFAULT_SETTINGS.autoCoverArt,
      spellcheck: typeof value.spellcheck === "boolean" ? value.spellcheck : DEFAULT_SETTINGS.spellcheck,
      reopenWorkspace: typeof value.reopenWorkspace === "boolean" ? value.reopenWorkspace : DEFAULT_SETTINGS.reopenWorkspace,
      startInTray: typeof value.startInTray === "boolean" ? value.startInTray : DEFAULT_SETTINGS.startInTray,
      closeToTray: typeof value.closeToTray === "boolean" ? value.closeToTray : DEFAULT_SETTINGS.closeToTray,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Returns whether preferences could be saved, so the UI can describe temporary settings. */
export function saveSettings(settings: Settings, store: SettingsStorage | undefined = storage()): boolean {
  try {
    if (!store) return false;
    store.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, scaleVersion: 2 }));
    return true;
  } catch {
    return false;
  }
}
