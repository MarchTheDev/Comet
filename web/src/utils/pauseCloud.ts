import { validBinding } from "./incrementalSync";
import { validRcloneBinding } from "./rcloneBinding";

/** Pause legacy workspace bindings without deleting sync history or credentials.
 * The scoped text sync uses a separate v2 key and never resumes these full-
 * workspace histories. Damaged records are deliberately left alone. */
export function pauseStoredCloudBindings(store: Pick<Storage, "length" | "key" | "getItem" | "setItem">): void {
  try {
    const keys: string[] = [];
    for (let index = 0; index < store.length; index++) {
      const key = store.key(index);
      if (key && (key.startsWith("comet:drive-incremental:v1:") || key.startsWith("comet:rclone-sync:v1:"))) keys.push(key);
    }
    for (const key of keys) {
      try {
        const value: unknown = JSON.parse(store.getItem(key) ?? "null");
        if ((key.startsWith("comet:drive-incremental:v1:") ? validBinding(value) : validRcloneBinding(value)) &&
            value && typeof value === "object" && "enabled" in value && value.enabled === true) {
          store.setItem(key, JSON.stringify({ ...value, enabled: false }));
        }
      } catch { /* preserve unreadable records or blocked storage unchanged */ }
    }
  } catch { /* storage may be unavailable; no sync is started regardless */ }
}
