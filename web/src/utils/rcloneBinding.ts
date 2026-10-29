import { validBinding, type DriveBinding } from "./incrementalSync";

export interface CloudAccount { remote: string; provider: "icloud" | "google"; identity: string; label: string }
export interface RcloneBinding extends DriveBinding { remote: string; provider: "icloud" | "google"; identity: string }
export const rcloneBindingKey = (vault: string) => `comet:rclone-sync:v1:${encodeURIComponent(vault)}`;
export function validRcloneBinding(value: unknown): value is RcloneBinding {
  const b = value as Partial<RcloneBinding> | null;
  // Persist an initial intent before the first network attempt so an offline
  // start is retried after reconnect or restart. A half-filled baseline is invalid.
  if (!b || !(validBinding(value) || (b.group === "" && b.base === "" && typeof b.enabled === "boolean"))) return false;
  return ((b.provider === "google" && b.remote === "comet-google" && b.identity === "google") ||
    (b.provider === "icloud" && typeof b.remote === "string" && typeof b.identity === "string" && /^comet-icloud-[0-9a-f]{32}$/.test(b.remote) && /^[0-9a-f]{64}$/.test(b.identity)));
}
export function readRcloneBinding(vault: string): RcloneBinding | null {
  try { const value: unknown = JSON.parse(localStorage.getItem(rcloneBindingKey(vault)) || "null"); return validRcloneBinding(value) ? value : null; }
  catch { return null; }
}
export function saveRcloneBinding(vault: string, binding: RcloneBinding): void {
  if (!validRcloneBinding(binding)) throw new Error("Invalid cloud sync binding.");
  localStorage.setItem(rcloneBindingKey(vault), JSON.stringify(binding));
  const saved = readRcloneBinding(vault);
  if (!saved || Object.keys(binding).some((key) => saved[key as keyof RcloneBinding] !== binding[key as keyof RcloneBinding])) throw new Error("This device could not save its cloud sync state.");
}
export function accountForBinding(binding: RcloneBinding | null, accounts: CloudAccount[]): CloudAccount | null {
  if (!binding) return null;
  return accounts.find((item) => item.remote === binding.remote && item.provider === binding.provider && item.identity === binding.identity)
    ?? accounts.find((item) => item.provider === binding.provider && item.identity === binding.identity) ?? null;
}
