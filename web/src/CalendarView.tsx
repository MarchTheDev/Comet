import { useMemo, useState, type FormEvent } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Download, Pencil, Plus, Trash2, X } from "lucide-react";
import { calendarId, calendarIcs, dateKey, MAX_CALENDAR_EVENTS, monthDays, parseCalendarDate, readCalendar, saveCalendar, type CalendarEvent } from "./utils/calendar";

const fullDate = (date: Date) => new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(date);
const monthLabel = (date: Date) => new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(date);
const weekdays = monthDays(2024, 0).slice(0, 7).map((date) => new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date));
const blankEvent = (date: string): CalendarEvent => ({ id: calendarId(), title: "", date, time: "", notes: "" });

/** A private calendar for the current workspace, stored in this device's Comet profile. */
export function CalendarView({ vault, name }: { vault: string; name: string }) {
  const [initial] = useState(() => readCalendar(vault));
  const [events, setEvents] = useState<CalendarEvent[]>(initial.events);
  const [selected, setSelected] = useState(() => dateKey(new Date()));
  const [month, setMonth] = useState(() => { const today = new Date(); return new Date(today.getFullYear(), today.getMonth(), 1, 12); });
  const [draft, setDraft] = useState<CalendarEvent | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState("");
  const [error, setError] = useState("");
  const days = useMemo(() => monthDays(month.getFullYear(), month.getMonth()), [month]);
  const grouped = useMemo(() => {
    const result = new Map<string, CalendarEvent[]>();
    for (const event of events) result.set(event.date, [...(result.get(event.date) ?? []), event]);
    for (const values of result.values()) values.sort((a, b) => (a.time || "").localeCompare(b.time || "") || a.title.localeCompare(b.title));
    return result;
  }, [events]);
  const selectedEvents = grouped.get(selected) ?? [];
  const selectedDate = parseCalendarDate(selected)!;
  const pickDay = (date: Date) => { const key = dateKey(date); setSelected(key); setMonth(new Date(date.getFullYear(), date.getMonth(), 1, 12)); setDraft((current) => current ? { ...current, date: key } : null); setDeleting(""); setError(""); };
  const changeMonth = (offset: number) => setMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1, 12));
  const createEvent = () => { setEditing(false); setDraft(blankEvent(selected)); setDeleting(""); setError(""); };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    const title = draft.title.trim(), date = parseCalendarDate(draft.date);
    if (!title || !date) { setError("Please add a title and a valid date."); return; }
    const item = { ...draft, title };
    const next = editing ? events.map((existing) => existing.id === item.id ? item : existing) : [...events, item];
    if (!saveCalendar(vault, next, undefined, events)) { setError("Couldn't save this event. Your form is still here; check device storage or reload if this calendar changed elsewhere."); return; }
    setEvents(next); setSelected(item.date); setMonth(new Date(date.getFullYear(), date.getMonth(), 1, 12)); setDraft(null); setError("");
  };
  const remove = (id: string) => {
    const next = events.filter((item) => item.id !== id);
    if (!saveCalendar(vault, next, undefined, events)) { setError("Couldn't save the deletion. The event hasn't been removed; check device storage or reload if this calendar changed elsewhere."); return; }
    setEvents(next); setDeleting(""); setError("");
  };
  const exportCalendar = () => {
    const url = URL.createObjectURL(new Blob([calendarIcs(events)], { type: "text/calendar;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = "comet-calendar.ics"; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const ready = initial.status === "ready";
  return <section className="calendar-card" aria-labelledby="calendar-title">
    <div className="calendar-heading"><span className="calendar-heading-icon"><CalendarDays size={21} /></span><div><span className="section-eyebrow">MAKE ROOM FOR WHAT MATTERS</span><h1 id="calendar-title">Calendar</h1><p>Your plans for {name}, all in one place.</p></div><div className="calendar-heading-actions"><button type="button" className="secondary-button" disabled={!events.length || !ready} onClick={exportCalendar} title="Export events as an iCalendar file"><Download size={15} /> Export</button><button type="button" className="primary-button" disabled={!ready || events.length >= MAX_CALENDAR_EVENTS} onClick={createEvent}><Plus size={16} /> New event</button></div></div>
    <p className="calendar-privacy">Events are saved on this device for this workspace, not in your vault or synced online. Export a backup whenever you need one.</p>
    {!ready && <div className="dialog-error" role="alert">{initial.status === "invalid" ? "This calendar has an unknown or damaged format. Its stored data has not been changed." : "Calendar storage isn't available on this device. Your stored events have not been changed."}</div>}
    <div className="calendar-layout">
      <div className="calendar-month">
        <div className="calendar-month-header"><div><span className="calendar-kicker">MONTH VIEW</span><h2 aria-live="polite">{monthLabel(month)}</h2></div><div className="calendar-month-actions"><button type="button" className="calendar-today" onClick={() => pickDay(new Date())}>Today</button><button type="button" aria-label="Previous month" disabled={month.getFullYear() <= 100 && month.getMonth() === 0} onClick={() => changeMonth(-1)}><ChevronLeft size={17} /></button><button type="button" aria-label="Next month" disabled={month.getFullYear() >= 9999 && month.getMonth() === 11} onClick={() => changeMonth(1)}><ChevronRight size={17} /></button></div></div>
        <div className="calendar-weekdays" aria-hidden="true">{weekdays.map((day, index) => <span key={index}>{day}</span>)}</div>
        <div className="calendar-grid" aria-label={monthLabel(month)}>{days.map((date) => {
          const key = dateKey(date), items = grouped.get(key) ?? [], today = key === dateKey(new Date());
          return <button type="button" key={key} disabled={date.getFullYear() < 100 || date.getFullYear() > 9999} className={`calendar-day${date.getMonth() !== month.getMonth() ? " outside" : ""}${selected === key ? " selected" : ""}${today ? " today" : ""}`} aria-label={`${fullDate(date)}${items.length ? `, ${items.length} ${items.length === 1 ? "event" : "events"}` : ""}`} aria-pressed={selected === key} onClick={() => pickDay(date)}><span className="calendar-day-number">{date.getDate()}</span><span className="calendar-day-events">{items.slice(0, 2).map((item) => <span key={item.id}>{item.title}</span>)}{items.length > 2 && <small>+{items.length - 2} more</small>}</span>{items.length > 0 && <span className="calendar-day-dot" aria-hidden="true" />}</button>;
        })}</div>
      </div>
      <aside className="calendar-agenda" aria-label="Selected day events">
        <div className="calendar-agenda-header"><span className="calendar-kicker">YOUR DAY</span><h2>{fullDate(selectedDate)}</h2><p>{selectedEvents.length} {selectedEvents.length === 1 ? "event" : "events"}</p></div>
        {error && <div className="dialog-error" role="alert">{error}</div>}
        {draft ? <form className="calendar-form" onSubmit={save}>
          <div className="calendar-form-heading"><strong>{editing ? "Edit event" : "New event"}</strong><button type="button" aria-label="Cancel event" onClick={() => { setDraft(null); setError(""); }}><X size={16} /></button></div>
          <label>Title<input autoFocus required maxLength={200} aria-label="Event title" placeholder="What's happening?" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
          <div className="calendar-form-grid"><label>Date<input required type="date" min="0100-01-01" max="9999-12-31" aria-label="Event date" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} /></label><label>Time <small>optional</small><input type="time" aria-label="Event time" value={draft.time} onChange={(event) => setDraft({ ...draft, time: event.target.value })} /></label></div>
          <label>Notes <small>optional</small><textarea maxLength={5000} aria-label="Event notes" placeholder="A little more detail…" value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
          <div className="calendar-form-actions"><button className="secondary-button" type="button" onClick={() => { setDraft(null); setError(""); }}>Cancel</button><button className="primary-button" type="submit">Save event</button></div>
        </form> : <>
          {selectedEvents.length ? <div className="calendar-event-list">{selectedEvents.map((item) => <article className="calendar-event" key={item.id}><div className="calendar-event-marker" /><div className="calendar-event-copy"><strong>{item.title}</strong><span><Clock3 size={13} /> {item.time || "All day"}</span>{item.notes && <p>{item.notes}</p>}</div><button type="button" disabled={!ready} aria-label={`Edit ${item.title}`} onClick={() => { setDraft({ ...item }); setEditing(true); setDeleting(""); setError(""); }}><Pencil size={15} /></button>{deleting === item.id ? <div className="calendar-delete-confirm"><span>Delete this event?</span><button type="button" onClick={() => remove(item.id)}>Delete</button><button type="button" aria-label="Cancel deleting event" onClick={() => setDeleting("")}><X size={14} /></button></div> : <button type="button" disabled={!ready} aria-label={`Delete ${item.title}`} onClick={() => setDeleting(item.id)}><Trash2 size={15} /></button>}</article>)}</div> : <div className="calendar-empty"><CalendarDays size={22} /><strong>A little breathing room</strong><span>There are no events on this day.</span></div>}
          <button type="button" className="calendar-add-day" disabled={!ready || events.length >= MAX_CALENDAR_EVENTS} onClick={createEvent}><Plus size={15} /> Add an event</button>
        </>}
      </aside>
    </div>
  </section>;
}
