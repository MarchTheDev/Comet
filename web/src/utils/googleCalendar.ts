import { calendarDate, dateKey, parseCalendarDate, type CalendarEvent } from "./calendar";
export interface GoogleTime { date?: string; dateTime?: string }
export interface GoogleCalendarEvent extends CalendarEvent { googleId: string; etag: string; start: GoogleTime; end: GoogleTime; recurring: boolean; editable: boolean }
const item = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const localKey = (value: string): { date: string; time: string } | null => {
  const date = new Date(value); if (!Number.isFinite(date.valueOf())) return null;
  return { date: dateKey(date), time: `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}` };
};
export function parseGoogleEvents(value: unknown): GoogleCalendarEvent[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 2500).flatMap((raw): GoogleCalendarEvent[] => {
    if (!item(raw) || raw.status === "cancelled" || typeof raw.id !== "string" || !/^[a-z0-9_-]{1,1024}$/i.test(raw.id) || typeof raw.etag !== "string" || raw.etag.length > 512 || !item(raw.start) || !item(raw.end)) return [];
    const start = raw.start as GoogleTime, end = raw.end as GoogleTime;
    const beginning = typeof start.date === "string" && parseCalendarDate(start.date) ? { date: start.date, time: "" } : typeof start.dateTime === "string" ? localKey(start.dateTime) : null;
    if (!beginning || !parseCalendarDate(beginning.date)) return [];
    const title = typeof raw.summary === "string" ? raw.summary : "", notes = typeof raw.description === "string" ? raw.description : "";
    return [{ id: `google:${raw.id}`, googleId: raw.id, etag: raw.etag, title: title || "(Untitled Google event)", notes: notes.slice(0, 5000), ...beginning, start, end, recurring: typeof raw.recurringEventId === "string", editable: title.length <= 200 && notes.length <= 5000 && Boolean(raw.etag) }];
  });
}
const isoDay = (date: string) => { const day = parseCalendarDate(date); if (!day) throw new Error("Enter a valid event date."); const utc = new Date(0); utc.setUTCFullYear(day.getFullYear(), day.getMonth(), day.getDate()); utc.setUTCHours(0, 0, 0, 0); return utc.getTime(); };
const dayString = (time: number) => { const value = new Date(time).toISOString(); if (!/^\d{4}-/.test(value)) throw new Error("The event end is outside the supported year range."); return value.slice(0, 10); };
function startInstant(date: string, time: string): Date {
  const day = parseCalendarDate(date); if (!day || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("Enter a valid date and time.");
  const [hour, minute] = time.split(":").map(Number), value = calendarDate(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
  if (value.getHours() !== hour || value.getMinutes() !== minute) throw new Error("That local time doesn't exist because the clock changes. Choose another time.");
  return value;
}
/** Patch only fields the user changed, preserving Google-only metadata. */
export function googleEventPatch(draft: CalendarEvent, original?: GoogleCalendarEvent): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (!original || draft.title !== original.title) patch.summary = draft.title;
  if (!original || draft.notes !== original.notes) patch.description = draft.notes;
  if (!original || draft.date !== original.date || draft.time !== original.time) {
    if (!draft.time) {
      const days = original?.start.date && original.end.date ? Math.max(1, Math.round((isoDay(original.end.date) - isoDay(original.start.date)) / 86_400_000)) : 1;
      patch.start = { date: draft.date }; patch.end = { date: dayString(isoDay(draft.date) + days * 86_400_000) };
    } else {
      const start = startInstant(draft.date, draft.time);
      const duration = original?.start.dateTime && original.end.dateTime ? Date.parse(original.end.dateTime) - Date.parse(original.start.dateTime) : 3_600_000;
      if (!Number.isFinite(duration) || duration <= 0 || duration > 366 * 86_400_000) throw new Error("This Google event has an unsupported duration. Edit it in Google Calendar.");
      patch.start = { dateTime: start.toISOString() }; patch.end = { dateTime: new Date(start.getTime() + duration).toISOString() };
    }
  }
  return patch;
}
