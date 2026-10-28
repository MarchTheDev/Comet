import { AppSelect } from "./AppSelect";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Cloud, Download, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { googleEventPatch, parseGoogleEvents, type GoogleCalendarEvent } from "./utils/googleCalendar";
import { calendarDate, calendarId, calendarIcs, dateKey, MAX_CALENDAR_EVENTS, monthDays, parseCalendarDate, readCalendar, saveCalendar, type CalendarEvent } from "./utils/calendar";

const fullDate = (date: Date) => new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(date);
const monthLabel = (date: Date) => new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date);
const weekdays = monthDays(2024, 0).slice(0, 7).map((date) => new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date));
const blankEvent = (date: string): CalendarEvent => ({ id: calendarId(), title: "", date, time: "", notes: "" });

/** Local workspace events and, when authorized, the primary Google Calendar. */
export function CalendarView({ vault, name, desktop = false, onConnect }: { vault: string; name: string; desktop?: boolean; onConnect?: () => void }) {
  const [initial] = useState(() => readCalendar(vault));
  const [events, setEvents] = useState<CalendarEvent[]>(initial.events);
  const [selected, setSelected] = useState(() => dateKey(new Date()));
  const [month, setMonth] = useState(() => { const today = new Date(); return calendarDate(today.getFullYear(), today.getMonth(), 1); });
  const [picker, setPicker] = useState<"days" | "months" | "years">("days");
  const [yearStart, setYearStart] = useState(() => 1 + Math.floor((new Date().getFullYear() - 1) / 12) * 12);
  const [jumpYear, setJumpYear] = useState("");
  const [draft, setDraft] = useState<CalendarEvent | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState("");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false), [googleEvents, setGoogleEvents] = useState<GoogleCalendarEvent[]>([]), [googleError, setGoogleError] = useState(""), [googleLoading, setGoogleLoading] = useState(false), [refresh, setRefresh] = useState(0), [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<"local" | "google">("local"), [editingGoogle, setEditingGoogle] = useState<GoogleCalendarEvent | null>(null);
  useEffect(() => { if (!desktop) return; let active = true; void invoke<boolean>("google_status", { service: "calendar" }).then((value) => { if (active) setConnected(value); }).catch((reason) => { if (active) setGoogleError(String(reason)); }); return () => { active = false; }; }, [desktop]);
  useEffect(() => {
    if (!connected) { setGoogleEvents([]); return; }
    let active = true; setGoogleLoading(true); setGoogleError(""); setGoogleEvents([]);
    const visible = monthDays(month.getFullYear(), month.getMonth());
    const first = visible.find((day) => day.getFullYear() >= 1) ?? visible[0];
    const last = [...visible].reverse().find((day) => day.getFullYear() <= 9999) ?? visible[visible.length - 1];
    const start = calendarDate(first.getFullYear(), first.getMonth(), first.getDate(), 0);
    const end = last.getFullYear() === 9999 && last.getMonth() === 11 && last.getDate() === 31 ? calendarDate(9999, 11, 31, 23, 59) : calendarDate(last.getFullYear(), last.getMonth(), last.getDate() + 1, 0);
    void invoke<unknown>("google_calendar_list", { start: start.toISOString(), end: end.toISOString() }).then((result) => { if (active) setGoogleEvents(parseGoogleEvents(result)); }).catch((reason) => { if (active) setGoogleError(String(reason)); }).finally(() => { if (active) setGoogleLoading(false); });
    return () => { active = false; };
  }, [connected, month, refresh]);
  const days = useMemo(() => monthDays(month.getFullYear(), month.getMonth()), [month]);
  const grouped = useMemo(() => {
    const result = new Map<string, CalendarEvent[]>();
    for (const event of [...events, ...googleEvents]) result.set(event.date, [...(result.get(event.date) ?? []), event]);
    for (const values of result.values()) values.sort((a, b) => (a.time || "").localeCompare(b.time || "") || a.title.localeCompare(b.title));
    return result;
  }, [events, googleEvents]);
  const selectedEvents = grouped.get(selected) ?? [];
  const selectedDate = parseCalendarDate(selected)!;
  const pickDay = (date: Date) => { const key = dateKey(date); setSelected(key); setMonth(calendarDate(date.getFullYear(), date.getMonth(), 1)); setDraft((current) => current ? { ...current, date: key } : null); setDeleting(""); setError(""); };
  const navigate = (offset: number) => {
    if (picker === "years") setYearStart((current) => Math.max(1, Math.min(9999, current + offset * 12)));
    else setMonth((current) => {
      const total = (current.getFullYear() * 12 + current.getMonth()) + offset * (picker === "months" ? 12 : 1);
      const bounded = Math.max(1 * 12, Math.min(9999 * 12 + 11, total));
      return calendarDate(Math.floor(bounded / 12), bounded % 12, 1);
    });
  };
  const previousDisabled = picker === "years" ? yearStart <= 1 : picker === "months" ? month.getFullYear() <= 1 : month.getFullYear() <= 1 && month.getMonth() === 0;
  const nextDisabled = picker === "years" ? yearStart + 11 >= 9999 : picker === "months" ? month.getFullYear() >= 9999 : month.getFullYear() >= 9999 && month.getMonth() === 11;
  const selectMonth = (index: number) => { setMonth(calendarDate(month.getFullYear(), index, 1)); setPicker("days"); };
  const selectYear = (year: number) => { setMonth(calendarDate(year, month.getMonth(), 1)); setPicker("months"); };
  const createEvent = () => { setEditing(false); setEditingGoogle(null); setTarget(connected ? "google" : "local"); setDraft(blankEvent(selected)); setDeleting(""); setError(""); };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || busy) return;
    const title = draft.title.trim(), date = parseCalendarDate(draft.date);
    if (!title || !date) { setError("Please add a title and a valid date."); return; }
    const item = { ...draft, title };
    if (target === "google") {
      setBusy(true); setError("");
      try {
        const patch = googleEventPatch(item, editingGoogle ?? undefined);
        if (!editingGoogle) await invoke("google_calendar_create", { patch });
        else if (Object.keys(patch).length) await invoke("google_calendar_update", { id: editingGoogle.googleId, etag: editingGoogle.etag, patch });
        setSelected(item.date); setMonth(calendarDate(date.getFullYear(), date.getMonth(), 1)); setDraft(null); setEditingGoogle(null); setRefresh((value) => value + 1);
      } catch (reason) { setError(`Couldn't save to Google: ${String(reason)}`); }
      finally { setBusy(false); }
      return;
    }
    const next = editing ? events.map((existing) => existing.id === item.id ? item : existing) : [...events, item];
    if (!saveCalendar(vault, next, undefined, events)) { setError("Couldn't save this event. Your form is still here; check device storage or reload if this calendar changed elsewhere."); return; }
    setEvents(next); setSelected(item.date); setMonth(calendarDate(date.getFullYear(), date.getMonth(), 1)); setDraft(null); setError("");
  };
  const remove = async (item: CalendarEvent) => {
    if (busy) return;
    if ("googleId" in item) {
      const remote = item as GoogleCalendarEvent; setBusy(true); setError("");
      try { await invoke("google_calendar_delete", { id: remote.googleId, etag: remote.etag }); setDeleting(""); setRefresh((value) => value + 1); }
      catch (reason) { setError(`Couldn't delete from Google: ${String(reason)}`); }
      finally { setBusy(false); }
      return;
    }
    const next = events.filter((event) => event.id !== item.id);
    if (!saveCalendar(vault, next, undefined, events)) { setError("Couldn't save the deletion. The event hasn't been removed; check device storage or reload if this calendar changed elsewhere."); return; }
    setEvents(next); setDeleting(""); setError("");
  };
  const moveToGoogle = async (item: CalendarEvent) => {
    if (busy || !connected) return; setBusy(true); setError("");
    try {
      await invoke("google_calendar_create", { patch: googleEventPatch(item) });
      const next = events.filter((event) => event.id !== item.id);
      if (!saveCalendar(vault, next, undefined, events)) { setError("Created in Google, but the local copy couldn't be removed. Both copies were kept; refresh before making changes."); }
      else setEvents(next);
      setRefresh((value) => value + 1);
    } catch (reason) { setError(`Couldn't move this event to Google: ${String(reason)}`); }
    finally { setBusy(false); }
  };
  const exportCalendar = () => {
    const url = URL.createObjectURL(new Blob([calendarIcs(events)], { type: "text/calendar;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "comet-calendar.ics"; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const ready = initial.status === "ready";
  return <section className="calendar-card" aria-labelledby="calendar-title">
    <div className="calendar-heading"><span className="calendar-heading-icon"><CalendarDays size={21} /></span><div><span className="section-eyebrow">MAKE ROOM FOR WHAT MATTERS</span><h1 id="calendar-title">Calendar</h1><p>Your plans for {name}, all in one place.</p></div><div className="calendar-heading-actions"><button type="button" className="secondary-button" disabled={!events.length || !ready} onClick={exportCalendar} title="Export events as an iCalendar file"><Download size={15} /> Export</button><button type="button" className="primary-button" disabled={!ready || events.length >= MAX_CALENDAR_EVENTS} onClick={createEvent}><Plus size={16} /> New event</button></div></div>
    {desktop && <div className="calendar-google"><Cloud size={15} /><span>{connected ? (googleLoading ? "Syncing Google Calendar…" : "Google Calendar connected") : "Google Calendar is not connected"}</span>{connected ? <button type="button" onClick={() => setRefresh((value) => value + 1)} disabled={googleLoading} aria-label="Refresh Google Calendar"><RefreshCw size={14} /> Refresh</button> : <button type="button" onClick={onConnect}>Connect</button>}</div>}
    {googleError && <p className="dialog-error" role="alert">Google Calendar: {googleError}</p>}
    {!ready && <div className="dialog-error" role="alert">{initial.status === "invalid" ? "This calendar has an unknown or damaged format. Its stored data has not been changed." : "Calendar storage isn't available on this device. Your stored events have not been changed."}</div>}
    <div className="calendar-layout">
      <div className="calendar-month">
        <div className="calendar-month-header"><h2 className="calendar-date-title" aria-live="polite"><button type="button" aria-label="Choose month" aria-pressed={picker === "months"} onClick={() => setPicker(picker === "months" ? "days" : "months")}>{new Intl.DateTimeFormat(undefined, { month: "long" }).format(month)}</button><button type="button" aria-label="Choose year" aria-pressed={picker === "years"} onClick={() => { setYearStart(1 + Math.floor((month.getFullYear() - 1) / 12) * 12); setPicker(picker === "years" ? "days" : "years"); }}>{month.getFullYear()}</button></h2><div className="calendar-month-actions"><button type="button" className="calendar-today" onClick={() => { pickDay(new Date()); setPicker("days"); }}>Today</button><button type="button" aria-label={`Previous ${picker === "years" ? "years" : picker === "months" ? "year" : "month"}`} disabled={previousDisabled} onClick={() => navigate(-1)}><ChevronLeft size={17} /></button><button type="button" aria-label={`Next ${picker === "years" ? "years" : picker === "months" ? "year" : "month"}`} disabled={nextDisabled} onClick={() => navigate(1)}><ChevronRight size={17} /></button></div></div>
        {picker === "days" ? <div className="calendar-transition" key={`days-${month.getFullYear()}-${month.getMonth()}`}>
          <div className="calendar-weekdays" aria-hidden="true">{weekdays.map((day, index) => <span key={index}>{day}</span>)}</div>
          <div className="calendar-grid" aria-label={monthLabel(month)}>{days.map((date) => {
            const key = dateKey(date), items = grouped.get(key) ?? [], today = key === dateKey(new Date());
            return <button type="button" key={key} disabled={date.getFullYear() < 1 || date.getFullYear() > 9999} className={`calendar-day${date.getMonth() !== month.getMonth() ? " outside" : ""}${selected === key ? " selected" : ""}${today ? " today" : ""}`} aria-label={`${fullDate(date)}${items.length ? `, ${items.length} ${items.length === 1 ? "event" : "events"}` : ""}`} aria-pressed={selected === key} onClick={() => pickDay(date)}><span className="calendar-day-number">{date.getDate()}</span><span className="calendar-day-events">{items.slice(0, 2).map((item) => <span key={item.id}>{item.title}</span>)}{items.length > 2 && <small>+{items.length - 2} more</small>}</span>{items.length > 0 && <span className="calendar-day-dot" aria-hidden="true" />}</button>;
          })}</div>
        </div> : picker === "months" ? <div className="calendar-picker calendar-transition" key={`months-${month.getFullYear()}`} aria-label={`Choose a month in ${month.getFullYear()}`}>{Array.from({ length: 12 }, (_, index) => <button type="button" className={index === month.getMonth() ? "selected" : ""} aria-pressed={index === month.getMonth()} onClick={() => selectMonth(index)} key={index}>{new Intl.DateTimeFormat(undefined, { month: "long" }).format(new Date(2024, index, 1))}</button>)}</div> : <div className="calendar-picker calendar-transition" key={`years-${yearStart}`} aria-label="Choose a year">{Array.from({ length: Math.min(12, 10000 - yearStart) }, (_, index) => { const year = yearStart + index; return <button type="button" className={year === month.getFullYear() ? "selected" : ""} aria-pressed={year === month.getFullYear()} onClick={() => selectYear(year)} key={year}>{year}</button>; })}<form className="calendar-year-jump" onSubmit={(event) => { event.preventDefault(); const year = Number(jumpYear); if (Number.isInteger(year) && year >= 1 && year <= 9999) { selectYear(year); setJumpYear(""); } }}><label>Jump to year <input aria-label="Jump to year" type="number" min="1" max="9999" placeholder="1–9999" value={jumpYear} onChange={(event) => setJumpYear(event.target.value)} /></label><button type="submit" disabled={!jumpYear || Number(jumpYear) < 1 || Number(jumpYear) > 9999}>Go</button></form></div>}
      </div>
      <aside className="calendar-agenda" aria-label="Selected day events">
        <div className="calendar-agenda-header"><span className="calendar-kicker">YOUR DAY</span><h2>{fullDate(selectedDate)}</h2><p>{selectedEvents.length} {selectedEvents.length === 1 ? "event" : "events"}</p></div>
        {error && <div className="dialog-error" role="alert">{error}</div>}
        {draft ? <form className="calendar-form" onSubmit={(event) => void save(event)}>
          <div className="calendar-form-heading"><strong>{editing ? "Edit event" : "New event"}</strong><button type="button" aria-label="Cancel event" onClick={() => { setDraft(null); setError(""); }}><X size={16} /></button></div>
          {!editing && connected && <label>Save to<AppSelect label="Event calendar" value={target} onChange={(value) => setTarget(value as "local" | "google")}><option value="google">Google Calendar</option><option value="local">This workspace only</option></AppSelect></label>}
          {target === "google" && <small className="calendar-google-hint">New timed events last one hour. Existing event durations are preserved when possible.{editingGoogle?.recurring ? " This edits only this occurrence." : ""}</small>}
          <label>Title<input autoFocus required maxLength={200} aria-label="Event title" placeholder="What's happening?" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
          <div className="calendar-form-grid"><label>Date<input required type="date" min="0001-01-01" max="9999-12-31" aria-label="Event date" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} /></label><label>Time <small>optional</small><input type="time" aria-label="Event time" value={draft.time} onChange={(event) => setDraft({ ...draft, time: event.target.value })} /></label></div>
          <label>Notes <small>optional</small><textarea maxLength={5000} aria-label="Event notes" placeholder="A little more detail…" value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
          <div className="calendar-form-actions"><button className="secondary-button" type="button" onClick={() => { setDraft(null); setError(""); }}>Cancel</button><button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : "Save event"}</button></div>
        </form> : <>
          {selectedEvents.length ? <div className="calendar-event-list">{selectedEvents.map((item) => {
            const google = "googleId" in item ? item as GoogleCalendarEvent : null;
            return <article className="calendar-event" key={item.id}><div className="calendar-event-marker" /><div className="calendar-event-copy"><strong>{item.title}</strong><span><Clock3 size={13} /> {item.time || "All day"}{google ? " · Google" : connected ? " · Local" : ""}{google?.recurring ? " · recurring" : ""}</span>{item.notes && <p>{item.notes}</p>}</div>{!google && connected && <button type="button" disabled={busy} aria-label={`Move ${item.title} to Google Calendar`} title="Move this local event to Google Calendar" onClick={() => void moveToGoogle(item)}><Cloud size={15} /></button>}<button type="button" disabled={!ready || busy || Boolean(google && !google.editable)} title={google && !google.editable ? "Edit this longer event in Google Calendar" : "Edit"} aria-label={`Edit ${item.title}`} onClick={() => { setDraft({ id: item.id, title: item.title, date: item.date, time: item.time, notes: item.notes }); setEditing(true); setEditingGoogle(google); setTarget(google ? "google" : "local"); setDeleting(""); setError(""); }}><Pencil size={15} /></button>{deleting === item.id ? <div className="calendar-delete-confirm"><span>Delete {google ? "from Google" : "this event"}?</span><button type="button" disabled={busy} onClick={() => void remove(item)}>Delete</button><button type="button" aria-label="Cancel deleting event" onClick={() => setDeleting("")}><X size={14} /></button></div> : <button type="button" disabled={!ready || busy || Boolean(google && !google.editable)} aria-label={`Delete ${item.title}`} onClick={() => setDeleting(item.id)}><Trash2 size={15} /></button>}</article>;
          })}</div> : <div className="calendar-empty"><CalendarDays size={22} /><strong>A little breathing room</strong><span>There are no events on this day.</span></div>}
          <button type="button" className="calendar-add-day" disabled={!ready || events.length >= MAX_CALENDAR_EVENTS} onClick={createEvent}><Plus size={15} /> Add an event</button>
        </>}
      </aside>
    </div>
  </section>;
}
