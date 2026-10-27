import { normalizePath } from "./vault";

export interface CalendarEvent { id: string; title: string; date: string; time: string; notes: string }
interface CalendarDocument { format: "comet-calendar"; version: 1; events: CalendarEvent[] }
type Store = Pick<Storage, "getItem" | "setItem">;
export type CalendarRead = { status: "ready"; events: CalendarEvent[] } | { status: "unavailable" | "invalid"; events: [] };
const PREFIX = "comet:calendar:v1:";
export const MAX_CALENDAR_EVENTS = 5000;
const keyFor = (vault: string) => `${PREFIX}${encodeURIComponent(normalizePath(vault))}`;
function storage(): Store | undefined { try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; } }

/** Dates are local calendar days, not UTC instants. */
export function dateKey(date: Date): string {
  return `${date.getFullYear().toString().padStart(4, "0")}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")}`;
}
export function parseCalendarDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (year < 100 || year > 9999) return null;
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}
export function monthDays(year: number, month: number): Date[] {
  const first = new Date(year, month, 1, 12);
  const mondayOffset = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => new Date(year, month, 1 - mondayOffset + index, 12));
}
const validEvent = (value: unknown): value is CalendarEvent => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as CalendarEvent;
  return Object.keys(value).every((key) => ["id", "title", "date", "time", "notes"].includes(key)) &&
    typeof event.id === "string" && !!event.id && event.id.length <= 200 && typeof event.title === "string" && !!event.title.trim() && event.title.length <= 200 &&
    typeof event.date === "string" && !!parseCalendarDate(event.date) && typeof event.time === "string" && (event.time === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(event.time)) &&
    typeof event.notes === "string" && event.notes.length <= 5000;
};
export function readCalendar(vault: string, store: Store | undefined = storage()): CalendarRead {
  try {
    if (!store) return { status: "unavailable", events: [] };
    const raw = store.getItem(keyFor(vault));
    if (raw === null) return { status: "ready", events: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: "invalid", events: [] };
    const doc = parsed as CalendarDocument;
    if (Object.keys(doc).some((key) => !["format", "version", "events"].includes(key)) || doc.format !== "comet-calendar" || doc.version !== 1 || !Array.isArray(doc.events) || doc.events.length > MAX_CALENDAR_EVENTS || !doc.events.every(validEvent) || new Set(doc.events.map((event) => event.id)).size !== doc.events.length) return { status: "invalid", events: [] };
    return { status: "ready", events: doc.events };
  } catch (error) { return { status: error instanceof SyntaxError ? "invalid" : "unavailable", events: [] }; }
}
export function saveCalendar(vault: string, events: CalendarEvent[], store: Store | undefined = storage(), expected?: CalendarEvent[]): boolean {
  try {
    if (!store || events.length > MAX_CALENDAR_EVENTS || !events.every(validEvent) || new Set(events.map((event) => event.id)).size !== events.length) return false;
    const current = readCalendar(vault, store);
    // Don't overwrite an unknown/newer document or another window's edits.
    if (current.status !== "ready" || (expected && JSON.stringify(current.events) !== JSON.stringify(expected))) return false;
    store.setItem(keyFor(vault), JSON.stringify({ format: "comet-calendar", version: 1, events } satisfies CalendarDocument));
    return true;
  } catch { return false; }
}
export function calendarId(): string { return globalThis.crypto?.randomUUID?.() ?? `event-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
const escapeIcs = (value: string) => value.replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
// RFC 5545 folds content lines at 75 UTF-8 octets, never inside a character.
function foldIcsLine(line: string): string {
  const encoder = new TextEncoder(); let part = "", bytes = 0; const segments: string[] = [];
  for (const character of line) {
    const count = encoder.encode(character).length;
    if (bytes + count > 75) { segments.push(part); part = " "; bytes = 1; }
    part += character; bytes += count;
  }
  segments.push(part); return segments.join("\r\n");
}
/** Export floating local times and all-day dates without an implicit timezone conversion. */
export function calendarIcs(events: CalendarEvent[]): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Comet//Calendar//EN", "CALSCALE:GREGORIAN"];
  for (const event of events) {
    const date = event.date.replace(/-/g, "");
    lines.push("BEGIN:VEVENT", `UID:${escapeIcs(event.id)}@comet.local`, `DTSTAMP:${stamp}`,
      event.time ? `DTSTART:${date}T${event.time.replace(":", "")}00` : `DTSTART;VALUE=DATE:${date}`,
      `SUMMARY:${escapeIcs(event.title)}`);
    if (event.notes) lines.push(`DESCRIPTION:${escapeIcs(event.notes)}`);
    lines.push("END:VEVENT");
  }
  return [...lines, "END:VCALENDAR"].map(foldIcsLine).join("\r\n") + "\r\n";
}
