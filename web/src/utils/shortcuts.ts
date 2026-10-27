export const SHORTCUT_ACTIONS = {
  search: "Search workspace",
  path: "Go to path",
  capture: "Quick capture",
  newFile: "New file",
  newFolder: "New folder",
  sidebar: "Toggle sidebar",
  save: "Save now",
  pin: "Pin or unpin current item",
  favorite: "Favorite or unfavorite current item",
  tags: "Manage tags",
  back: "Go back",
  forward: "Go forward",
} as const;
export type ShortcutAction = keyof typeof SHORTCUT_ACTIONS;
export type Shortcuts = Record<ShortcutAction, string>;
export const DEFAULT_SHORTCUTS: Shortcuts = {
  search: "Mod+K", path: "Mod+L", capture: "Mod+Shift+K", newFile: "Mod+N",
  newFolder: "Mod+Shift+N", sidebar: "Mod+\\", save: "Mod+S",
  pin: "Mod+Shift+P", favorite: "Mod+Shift+F", tags: "Mod+Shift+T",
  back: "Alt+ArrowLeft", forward: "Alt+ArrowRight",
};

export function keyboardShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">, mac: boolean): string {
  if (["Control", "Meta", "Alt", "Shift", "AltGraph", "Dead", "Unidentified"].includes(event.key)) return "";
  const keys: string[] = [];
  // The platform's primary command key is represented as Mod, so saved
  // shortcuts remain useful if a profile is migrated to another OS.
  if (mac ? event.metaKey : event.ctrlKey) keys.push("Mod");
  if (mac ? event.ctrlKey : event.metaKey) keys.push(mac ? "Ctrl" : "Meta");
  if (event.altKey) keys.push("Alt");
  if (event.shiftKey) keys.push("Shift");
  if (!keys.includes("Mod") && !keys.includes("Ctrl") && !keys.includes("Meta") && !keys.includes("Alt")) return "";
  const key = event.key === " " ? "Space" : event.key === "+" ? "Plus" : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return [...keys, key].join("+");
}

export function readShortcuts(value: unknown): Shortcuts {
  const result = { ...DEFAULT_SHORTCUTS };
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const supplied = value as Record<string, unknown>;
  for (const action of Object.keys(result) as ShortcutAction[]) {
    const shortcut = supplied[action];
    if (typeof shortcut === "string" && /^(?:(?:Mod|Ctrl|Meta|Alt|Shift)\+)+[^\s+]{1,20}$/i.test(shortcut)) result[action] = shortcut;
  }
  return result;
}

export function shortcutLabel(shortcut: string, mac: boolean): string {
  return shortcut.replace("Mod", mac ? "⌘" : "Ctrl").replace("ArrowLeft", "←").replace("ArrowRight", "→").replace(/\+/g, " ");
}
