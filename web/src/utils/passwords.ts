/** Passwords are encrypted on-device; the master password/key is never stored. */
export interface PasswordEntry { id: string; name: string; website: string; username: string; password: string; notes: string }
export interface PasswordData { format: "comet-passwords-data"; version: 1; entries: PasswordEntry[] }
export interface PasswordEnvelope { format: "comet-passwords"; version: 1; kdf: "PBKDF2-SHA256"; iterations: number; salt: string; iv: string; ciphertext: string }
export const PASSWORD_STORAGE_KEY = "comet:password-vault:v1";
export const PASSWORD_ITERATIONS = 600_000;
const bytesTo64 = (bytes: Uint8Array) => { let text = ""; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(text); };
const from64 = (value: string): Uint8Array => { const raw = atob(value); return Uint8Array.from(raw, (char) => char.charCodeAt(0)); };
const exact = (value: object, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
export function parsePasswordEnvelope(raw: string): PasswordEnvelope | null {
  try {
    if (raw.length > 8_000_000) return null;
    const v: unknown = JSON.parse(raw);
    if (!object(v) || !exact(v, ["format", "version", "kdf", "iterations", "salt", "iv", "ciphertext"]) || v.format !== "comet-passwords" || v.version !== 1 || v.kdf !== "PBKDF2-SHA256" || !Number.isInteger(v.iterations) || (v.iterations as number) < 600_000 || (v.iterations as number) > 2_000_000 || typeof v.salt !== "string" || typeof v.iv !== "string" || typeof v.ciphertext !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.salt) || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.iv) || !/^[A-Za-z0-9+/]+={0,2}$/.test(v.ciphertext) || from64(v.salt).length !== 16 || from64(v.iv).length !== 12 || from64(v.ciphertext).length < 16) return null;
    return v as unknown as PasswordEnvelope;
  } catch { return null; }
}
export function validPasswordData(value: unknown): value is PasswordData {
  if (!object(value) || !exact(value, ["format", "version", "entries"]) || value.format !== "comet-passwords-data" || value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > 1000) return false;
  const ids = new Set<string>();
  for (const entry of value.entries) {
    if (!object(entry) || !exact(entry, ["id", "name", "website", "username", "password", "notes"]) || typeof entry.id !== "string" || !entry.id || entry.id.length > 100 || ids.has(entry.id) || typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 200 || typeof entry.website !== "string" || entry.website.length > 2048 || typeof entry.username !== "string" || entry.username.length > 500 || typeof entry.password !== "string" || entry.password.length > 1000 || typeof entry.notes !== "string" || entry.notes.length > 5000) return false;
    if (entry.website && !passwordWebsite(entry.website)) return false;
    ids.add(entry.id);
  }
  return true;
}
export function passwordWebsite(value: string): string | null {
  try { const url = new URL(value.includes("://") ? value : `https://${value}`); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || !url.hostname || url.hostname.length > 253) return null; return url.href; } catch { return null; }
}
export function faviconUrl(website: string): string | null {
  const safe = passwordWebsite(website); if (!safe) return null;
  const host = new URL(safe).hostname.toLowerCase();
  // Never disclose local/private addresses to a third party.
  if (!host.includes(".") || /^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|\[)/.test(host) || /\.(?:local|internal|localhost)$/.test(host)) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}
export async function derivePasswordKey(password: string, salt: Uint8Array, iterations = PASSWORD_ITERATIONS): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: Uint8Array.from(salt), iterations, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function encryptPasswordData(data: PasswordData, key: CryptoKey, salt: Uint8Array, iterations = PASSWORD_ITERATIONS): Promise<string> {
  if (!validPasswordData(data)) throw new Error("The password vault contains invalid data.");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(data)));
  return JSON.stringify({ format: "comet-passwords", version: 1, kdf: "PBKDF2-SHA256", iterations, salt: bytesTo64(salt), iv: bytesTo64(iv), ciphertext: bytesTo64(new Uint8Array(cipher)) } satisfies PasswordEnvelope);
}
export async function unlockPasswordData(raw: string, password: string): Promise<{ data: PasswordData; key: CryptoKey; salt: Uint8Array; iterations: number }> {
  const envelope = parsePasswordEnvelope(raw); if (!envelope) throw new Error("Unknown or damaged password vault; it has not been changed.");
  const salt = from64(envelope.salt), key = await derivePasswordKey(password, salt, envelope.iterations);
  let data: unknown;
  try { const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Uint8Array.from(from64(envelope.iv)) }, key, Uint8Array.from(from64(envelope.ciphertext))); data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("Incorrect master password or damaged vault."); }
  if (!validPasswordData(data)) throw new Error("Unknown or damaged password vault; it has not been changed.");
  return { data, key, salt, iterations: envelope.iterations };
}
export function makePassword(length = 24): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%*-_+";
  let result = "";
  // Rejection sampling avoids modulo bias.
  while (result.length < length) for (const value of crypto.getRandomValues(new Uint8Array(48))) { if (value < 256 - (256 % chars.length)) result += chars[value % chars.length]; if (result.length === length) break; }
  return result;
}
