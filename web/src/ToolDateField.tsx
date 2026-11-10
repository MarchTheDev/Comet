import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { calendarDate, dateKey, monthDays, parseCalendarDate } from "./utils/calendar";

const monthName = (date: Date) => new Intl.DateTimeFormat(undefined, { month: "long" }).format(date);
const pad = (value: number) => String(value).padStart(2, "0");
/** Dates are typed and read as DD/MM/YYYY; ISO keys stay internal. */
const displayDate = (key: string) => { const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key); return match ? `${match[3]}/${match[2]}/${match[1]}` : ""; };
function typedDate(text: string): string | null {
  const trimmed = text.trim();
  const parts = /^(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{4})$/.exec(trimmed);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  const digits = trimmed.replace(/\D/g, "");
  const [year, month, day] = parts ? [Number(parts[3]), Number(parts[2]), Number(parts[1])]
    : iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3])]
    : digits.length === 8 ? [Number(digits.slice(4)), Number(digits.slice(2, 4)), Number(digits.slice(0, 2))]
    : [0, 0, 0];
  if (year < 1 || year > 9999) return null;
  const date = calendarDate(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? dateKey(date) : null;
}
const dayName = (date: Date) => `${new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date)} ${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
const weekdays = monthDays(2024, 0).slice(0, 7).map((date) => new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date));
const firstYear = (year: number) => 1 + Math.floor((year - 1) / 12) * 12;

/** A themed calendar over local civil days. Dates are shown and typed as DD/MM/YYYY. */
export function ToolDateField({ label, value, onChange }: { label: string; value: string; onChange(value: string): void }) {
  const id = useId(), root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), focusDay = useRef(false), lastWheel = useRef(0);
  const [month, setMonth] = useState(() => { const date = parseCalendarDate(value) ?? new Date(); return calendarDate(date.getFullYear(), date.getMonth(), 1); });
  const [active, setActive] = useState(() => dateKey(parseCalendarDate(value) ?? new Date()));
  const [picker, setPicker] = useState<"days" | "months" | "years">("days");
  const [text, setText] = useState(() => displayDate(value));
  useEffect(() => { setText(displayDate(value)); }, [value]);
  const typed = (raw: string) => {
    setText(raw);
    const parsed = typedDate(raw);
    if (parsed) onChange(parsed);
    else if (raw.trim() === "") onChange("");
  };
  const leave = () => { const parsed = typedDate(text); if (parsed) setText(displayDate(parsed)); };
  const [yearStart, setYearStart] = useState(() => firstYear(month.getFullYear()));
  const [jumpYear, setJumpYear] = useState("");
  const [position, setPosition] = useState({ left: 8, top: 8, width: 300, maxHeight: 400 });
  const selected = parseCalendarDate(value);
  const begin = () => {
    const date = selected ?? new Date();
    setMonth(calendarDate(date.getFullYear(), date.getMonth(), 1)); setActive(dateKey(date));
    setPicker("days"); setYearStart(firstYear(date.getFullYear())); setJumpYear(""); setOpen(true);
  };
  const close = (returnFocus = false) => { setOpen(false); if (returnFocus) trigger.current?.focus({ preventScroll: true }); };
  const moveTo = (date: Date, focus = false) => {
    if (date.getFullYear() < 1 || date.getFullYear() > 9999) return;
    setActive(dateKey(date)); setMonth(calendarDate(date.getFullYear(), date.getMonth(), 1));
    if (focus) focusDay.current = true;
  };
  const moveMonth = (year: number, nextMonth: number, focus = false) => {
    const date = parseCalendarDate(active) ?? month;
    moveTo(calendarDate(year, nextMonth, Math.min(date.getDate(), calendarDate(year, nextMonth + 1, 0).getDate())), focus);
  };
  const navigate = (offset: number, focus = false) => {
    if (picker === "years") { setYearStart((current) => Math.max(1, Math.min(firstYear(9999), current + offset * 12))); return; }
    const total = month.getFullYear() * 12 + month.getMonth() + offset * (picker === "months" ? 12 : 1);
    if (total < 12 || total > 9999 * 12 + 11) return;
    moveMonth(Math.floor(total / 12), total % 12, focus);
  };
  const previousDisabled = picker === "years" ? yearStart <= 1 : picker === "months" ? month.getFullYear() <= 1 : month.getFullYear() === 1 && month.getMonth() === 0;
  const nextDisabled = picker === "years" ? yearStart + 11 >= 9999 : picker === "months" ? month.getFullYear() >= 9999 : month.getFullYear() === 9999 && month.getMonth() === 11;
  const choose = (date: Date) => { onChange(dateKey(date)); close(true); };
  const chooseMonth = (index: number) => { moveMonth(month.getFullYear(), index, true); setPicker("days"); };
  const chooseYear = (year: number) => { moveMonth(year, month.getMonth()); setPicker("months"); setJumpYear(""); };
  const gridKey = (event: KeyboardEvent<HTMLButtonElement>, date: Date) => {
    let next: Date | null = null;
    if (event.key === "ArrowLeft") next = calendarDate(date.getFullYear(), date.getMonth(), date.getDate() - 1);
    if (event.key === "ArrowRight") next = calendarDate(date.getFullYear(), date.getMonth(), date.getDate() + 1);
    if (event.key === "ArrowUp") next = calendarDate(date.getFullYear(), date.getMonth(), date.getDate() - 7);
    if (event.key === "ArrowDown") next = calendarDate(date.getFullYear(), date.getMonth(), date.getDate() + 7);
    if (event.key === "Home") next = calendarDate(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7));
    if (event.key === "End") next = calendarDate(date.getFullYear(), date.getMonth(), date.getDate() + (6 - (date.getDay() + 6) % 7));
    if (event.key === "PageUp" || event.key === "PageDown") {
      const offset = (event.key === "PageUp" ? -1 : 1) * (event.shiftKey ? 12 : 1);
      const total = date.getFullYear() * 12 + date.getMonth() + offset;
      if (total >= 12 && total <= 9999 * 12 + 11) {
        const y = Math.floor(total / 12), m = total % 12;
        next = calendarDate(y, m, Math.min(date.getDate(), calendarDate(y, m + 1, 0).getDate()));
      }
    }
    if (next) { event.preventDefault(); event.stopPropagation(); moveTo(next, true); }
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { const target = event.target as Node; if (!root.current?.contains(target) && !panel.current?.contains(target)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = root.current?.getBoundingClientRect(), menu = panel.current;
      if (!anchor || !menu) return;
      const scale = Number(document.documentElement.style.zoom) || 1;
      const width = Math.min(310 * scale, window.innerWidth - 16), height = Math.min(menu.scrollHeight * scale, window.innerHeight - 16);
      const below = window.innerHeight - anchor.bottom - 8, above = anchor.top - 8;
      const top = below < height && above > below ? Math.max(8, anchor.top - height - 6) : Math.min(anchor.bottom + 6, window.innerHeight - height - 8);
      setPosition({ left: Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8)) / scale, top: Math.max(8, top) / scale, width: width / scale, maxHeight: (window.innerHeight - 16) / scale });
    };
    place(); window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, picker]);
  useLayoutEffect(() => {
    if (open && picker === "days" && focusDay.current) { focusDay.current = false; panel.current?.querySelector<HTMLButtonElement>(`[data-date="${active}"]`)?.focus({ preventScroll: true }); }
  }, [open, active, month, picker]);
  useEffect(() => { if (open) panel.current?.querySelector<HTMLButtonElement>(`[data-date="${active}"]`)?.focus({ preventScroll: true }); }, [open]);
  useEffect(() => {
    const menu = panel.current;
    if (!open || !menu) return;
    const wheel = (event: WheelEvent) => {
      if ((event.target as Element | null)?.closest("input") || !event.deltaY) return;
      event.preventDefault();
      // A trackpad emits many tiny events per gesture; don't skip years at once.
      const now = Date.now(); if (now - lastWheel.current < 180) return;
      lastWheel.current = now;
      const focusedDay = picker === "days" && Boolean((document.activeElement as Element | null)?.closest(".tool-calendar-grid"));
      navigate(event.deltaY > 0 ? 1 : -1, focusedDay);
    };
    menu.addEventListener("wheel", wheel, { passive: false });
    return () => menu.removeEventListener("wheel", wheel);
  }, [open, picker, month, active, yearStart]);
  return <div ref={root} className="tool-field tool-date-field">
    <label htmlFor={id}>{label}</label>
    <div className="tool-input-wrap tool-date-input"><input id={id} aria-label={label} aria-invalid={(text !== "" && !typedDate(text)) || (value !== "" && !selected)} inputMode="numeric" placeholder="DD/MM/YYYY" value={text} maxLength={10} autoComplete="off" onBlur={leave} onChange={(event) => typed(event.target.value)} />
      <button ref={trigger} type="button" className="tool-date-trigger" aria-label={`Choose ${label.toLowerCase()}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `${id}-calendar` : undefined} onClick={() => open ? close() : begin()}><CalendarDays size={16} /></button></div>
    {open && createPortal(<div ref={panel} id={`${id}-calendar`} className="tool-calendar-popup" role="dialog" aria-label={`${label} calendar`} style={position} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); } }}>
      <div className="tool-calendar-header"><div className="tool-calendar-title" aria-live="polite"><button type="button" aria-label="Choose month" aria-pressed={picker === "months"} onClick={() => setPicker(picker === "months" ? "days" : "months")}>{monthName(month)}</button><button type="button" aria-label="Choose year" aria-pressed={picker === "years"} onClick={() => { setYearStart(firstYear(month.getFullYear())); setPicker(picker === "years" ? "days" : "years"); }}>{month.getFullYear()}</button></div><div className="tool-calendar-nav"><button type="button" aria-label={`Previous ${picker === "years" ? "years" : picker === "months" ? "year" : "month"}`} disabled={previousDisabled} onClick={() => navigate(-1)}><ChevronLeft size={16} /></button><button type="button" aria-label={`Next ${picker === "years" ? "years" : picker === "months" ? "year" : "month"}`} disabled={nextDisabled} onClick={() => navigate(1)}><ChevronRight size={16} /></button></div></div>
      {picker === "days" ? <div className="tool-calendar-transition" key={`days-${month.getFullYear()}-${month.getMonth()}`}><div className="tool-calendar-weekdays" aria-hidden="true">{weekdays.map((day, index) => <span key={index}>{day}</span>)}</div>
        <div className="tool-calendar-grid">{monthDays(month.getFullYear(), month.getMonth()).map((date) => { const key = dateKey(date), valid = date.getFullYear() >= 1 && date.getFullYear() <= 9999; return <button type="button" key={key} data-date={key} disabled={!valid} tabIndex={key === active ? 0 : -1} className={`${date.getMonth() !== month.getMonth() ? "outside " : ""}${key === value ? "selected " : ""}${key === dateKey(new Date()) ? "today" : ""}`} aria-label={valid ? dayName(date) : undefined} aria-pressed={key === value} onClick={() => choose(date)} onKeyDown={(event) => gridKey(event, date)}>{date.getDate()}</button>; })}</div></div>
        : picker === "months" ? <div className="tool-calendar-picker tool-calendar-transition" key={`months-${month.getFullYear()}`} aria-label={`Choose a month in ${month.getFullYear()}`}>{Array.from({ length: 12 }, (_, index) => <button type="button" key={index} aria-pressed={index === month.getMonth()} onClick={() => chooseMonth(index)}>{monthName(calendarDate(2024, index, 1))}</button>)}</div>
        : <div className="tool-calendar-picker tool-calendar-transition" key={`years-${yearStart}`} aria-label="Choose a year">{Array.from({ length: Math.min(12, 10000 - yearStart) }, (_, index) => { const year = yearStart + index; return <button type="button" key={year} aria-pressed={year === month.getFullYear()} onClick={() => chooseYear(year)}>{year}</button>; })}<form className="tool-calendar-year-jump" onSubmit={(event) => { event.preventDefault(); const year = Number(jumpYear); if (Number.isInteger(year) && year >= 1 && year <= 9999) chooseYear(year); }}><label>Jump to year<input aria-label="Jump to year" type="number" min="1" max="9999" placeholder="1–9999" value={jumpYear} onChange={(event) => setJumpYear(event.target.value)} /></label><button type="submit" disabled={!jumpYear || Number(jumpYear) < 1 || Number(jumpYear) > 9999}>Go</button></form></div>}
      <button type="button" className="tool-calendar-today" onClick={() => choose(new Date())}>Today</button>
    </div>, document.body)}
  </div>;
}
