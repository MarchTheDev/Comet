/** Passwords are encrypted on-device; the master password/key is never stored. */
export interface PasswordEntry { id: string; name: string; website: string; username: string; password: string; notes: string }
export interface PasswordData { format: "comet-passwords-data"; version: 1; entries: PasswordEntry[] }
export interface PasswordEnvelope { format: "comet-passwords"; version: 1; kdf: "PBKDF2-SHA256"; iterations: number; salt: string; iv: string; ciphertext: string }
export const PASSWORD_STORAGE_KEY = "comet:password-vault:v1";
export const PASSWORD_ITERATIONS = 600_000;
export const MAX_PASSWORD_ENVELOPE_CHARS = 8_000_000;
const bytesTo64 = (bytes: Uint8Array) => { let text = ""; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(text); };
const from64 = (value: string): Uint8Array => { const raw = atob(value); return Uint8Array.from(raw, (char) => char.charCodeAt(0)); };
const exact = (value: object, keys: string[]) => Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
export function parsePasswordEnvelope(raw: string): PasswordEnvelope | null {
  try {
    if (raw.length > MAX_PASSWORD_ENVELOPE_CHARS) return null;
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
  if (!host.includes(".") || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[") || /\.(?:local|internal|localhost|localdomain)$/.test(host)) return null;
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}
export async function derivePasswordKey(password: string, salt: Uint8Array, iterations = PASSWORD_ITERATIONS, extractable = false): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: Uint8Array.from(salt), iterations, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, extractable, ["encrypt", "decrypt"]);
}
export async function encryptPasswordData(data: PasswordData, key: CryptoKey, salt: Uint8Array, iterations = PASSWORD_ITERATIONS): Promise<string> {
  if (!validPasswordData(data)) throw new Error("The password vault contains invalid data.");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(data)));
  const envelope = JSON.stringify({ format: "comet-passwords", version: 1, kdf: "PBKDF2-SHA256", iterations, salt: bytesTo64(salt), iv: bytesTo64(iv), ciphertext: bytesTo64(new Uint8Array(cipher)) } satisfies PasswordEnvelope);
  if (envelope.length > MAX_PASSWORD_ENVELOPE_CHARS) throw new Error("This vault is too large to save safely. Your existing vault was not changed.");
  return envelope;
}
export async function unlockPasswordData(raw: string, password: string, extractable = false): Promise<{ data: PasswordData; key: CryptoKey; salt: Uint8Array; iterations: number }> {
  const envelope = parsePasswordEnvelope(raw); if (!envelope) throw new Error("Unknown or damaged password vault; it has not been changed.");
  const salt = from64(envelope.salt), key = await derivePasswordKey(password, salt, envelope.iterations, extractable);
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

/** The recovery code is a random 256-bit key, never written to storage. */
export interface PasswordRecovery { format: "comet-password-recovery"; version: 1; salt: string; iv: string; wrappedKey: string }
interface PasswordBundle { format: "comet-passwords-bundle"; version: 1; envelope: string; recovery: PasswordRecovery }
export function generateRecoveryCode(): string {
  const hex = [...crypto.getRandomValues(new Uint8Array(32))].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase();
  return hex.match(/.{8}/g)!.join("-");
}
function recoveryBytes(code: string): Uint8Array {
  const hex = code.replace(/[\s-]/g, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("Enter the complete recovery code.");
  return Uint8Array.from(hex.match(/../g)!, (part) => parseInt(part, 16));
}
function validRecovery(value: unknown, salt: string): value is PasswordRecovery {
  try {
    return object(value) && exact(value, ["format", "version", "salt", "iv", "wrappedKey"]) && value.format === "comet-password-recovery" && value.version === 1 && value.salt === salt && typeof value.iv === "string" && typeof value.wrappedKey === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value.iv) && /^[A-Za-z0-9+/]+={0,2}$/.test(value.wrappedKey) && from64(value.iv).length === 12 && from64(value.wrappedKey).length === 48;
  } catch { return false; }
}
export function readPasswordStorage(raw: string): { envelope: string; recovery: PasswordRecovery | null } | null {
  try {
    if (raw.length > MAX_PASSWORD_ENVELOPE_CHARS + 2000) return null;
    const direct = parsePasswordEnvelope(raw); if (direct) return { envelope: raw, recovery: null };
    const value: unknown = JSON.parse(raw);
    if (!object(value) || !exact(value, ["format", "version", "envelope", "recovery"]) || value.format !== "comet-passwords-bundle" || value.version !== 1 || typeof value.envelope !== "string") return null;
    const envelope = parsePasswordEnvelope(value.envelope);
    return envelope && validRecovery(value.recovery, envelope.salt) ? { envelope: value.envelope, recovery: value.recovery } : null;
  } catch { return null; }
}
export function packPasswordStorage(envelope: string, recovery: PasswordRecovery | null): string {
  const parsed = parsePasswordEnvelope(envelope); if (!parsed || (recovery && !validRecovery(recovery, parsed.salt))) throw new Error("Invalid password recovery data.");
  return recovery ? JSON.stringify({ format: "comet-passwords-bundle", version: 1, envelope, recovery } satisfies PasswordBundle) : envelope;
}
export async function makeRecoveryRecord(key: CryptoKey, salt: Uint8Array, code: string): Promise<PasswordRecovery> {
  if (!key.extractable) throw new Error("Confirm your master password to set up recovery.");
  const recoveryKey = await crypto.subtle.importKey("raw", Uint8Array.from(recoveryBytes(code)), "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12)), rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  try {
    const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: Uint8Array.from(salt) }, recoveryKey, rawKey);
    return { format: "comet-password-recovery", version: 1, salt: bytesTo64(salt), iv: bytesTo64(iv), wrappedKey: bytesTo64(new Uint8Array(wrapped)) };
  } finally { rawKey.fill(0); }
}
export async function unlockPasswordRecovery(raw: string, code: string): Promise<{ data: PasswordData; key: CryptoKey; salt: Uint8Array; iterations: number }> {
  const storage = readPasswordStorage(raw); if (!storage?.recovery) throw new Error("This vault does not have a recovery code. An older backup may not include one.");
  const envelope = parsePasswordEnvelope(storage.envelope)!;
  const salt = from64(envelope.salt), recoveryKey = await crypto.subtle.importKey("raw", Uint8Array.from(recoveryBytes(code)), "AES-GCM", false, ["decrypt"]);
  let rawKey: Uint8Array;
  try { rawKey = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: Uint8Array.from(from64(storage.recovery.iv)), additionalData: Uint8Array.from(salt) }, recoveryKey, Uint8Array.from(from64(storage.recovery.wrappedKey)))); }
  catch { throw new Error("Incorrect recovery code or damaged recovery data."); }
  try {
    const key = await crypto.subtle.importKey("raw", Uint8Array.from(rawKey), "AES-GCM", false, ["encrypt", "decrypt"]);
    const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Uint8Array.from(from64(envelope.iv)) }, key, Uint8Array.from(from64(envelope.ciphertext)));
    const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!validPasswordData(data)) throw new Error();
    return { data, key, salt, iterations: envelope.iterations };
  } catch { throw new Error("The encrypted vault or recovery data is damaged."); }
  finally { rawKey.fill(0); }
}
