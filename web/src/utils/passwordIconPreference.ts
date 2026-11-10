export const PASSWORD_ICONS_KEY = "comet:password-site-icons:v1";

// If persistent storage rejects a preference change, keep it for this app
// session so navigating from Settings to the vault cannot undo an opt-out.
let sessionOverride: boolean | null = null;
export function readPasswordIconsEnabled(): boolean {
  if (sessionOverride !== null) return sessionOverride;
  try { return localStorage.getItem(PASSWORD_ICONS_KEY) !== "false"; } catch { return true; }
}
export function savePasswordIconsEnabled(enabled: boolean): boolean {
  try {
    localStorage.setItem(PASSWORD_ICONS_KEY, String(enabled));
    sessionOverride = null;
    return true;
  } catch {
    sessionOverride = enabled;
    return false;
  }
}
