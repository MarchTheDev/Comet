/** Small, bounded arithmetic parser. No JavaScript execution or expression eval. */
export function evaluateCalculation(input: string): number {
  if (!input.trim() || input.length > 256) throw new Error("Enter an expression of up to 256 characters.");
  const text = input.replace(/,/g, ".").replace(/[×✕]/g, "*").replace(/[÷]/g, "/").replace(/[−–]/g, "-");
  let at = 0;
  type Value = { value: number; percent: boolean };
  const skip = () => { while (/\s/.test(text[at] ?? "") && at < text.length) at++; };
  const take = (token: string) => { skip(); if (text[at] === token) { at++; return true; } return false; };
  const checked = (value: number, percent = false): Value => {
    if (!Number.isFinite(value)) throw new Error("The result is too large or undefined.");
    return { value, percent };
  };
  const expression = (): Value => {
    let result = term();
    for (;;) {
      if (take("+")) { const right = term(); result = checked(result.value + (right.percent ? result.value * right.value : right.value)); }
      else if (take("-")) { const right = term(); result = checked(result.value - (right.percent ? result.value * right.value : right.value)); }
      else return result;
    }
  };
  const term = (): Value => {
    let result = unary();
    for (;;) {
      if (take("*")) result = checked(result.value * unary().value);
      else if (take("/")) { const divisor = unary().value; if (divisor === 0) throw new Error("Cannot divide by zero."); result = checked(result.value / divisor); }
      else return result;
    }
  };
  const unary = (): Value => {
    if (take("+")) return unary();
    if (take("-")) { const next = unary(); return checked(-next.value, next.percent); }
    return power();
  };
  const power = (): Value => {
    let result = primary();
    while (take("%")) result = checked(result.value / 100, true);
    if (take("^")) result = checked(Math.pow(result.value, unary().value));
    return result;
  };
  const primary = (): Value => {
    if (take("(")) { const result = expression(); if (!take(")")) throw new Error("Close the parentheses."); return result; }
    skip();
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(text.slice(at));
    if (!match) throw new Error("Check the expression and try again.");
    at += match[0].length;
    return checked(Number(match[0]));
  };
  const result = expression(); skip();
  if (at !== text.length) throw new Error("Check the expression and try again.");
  return Object.is(result.value, -0) ? 0 : result.value;
}

/** Accept either decimal convention, without silently interpreting thousands separators. */
export function parseToolNumber(input: string): number | null {
  const text = input.trim();
  if (!/^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const value = Number(text.replace(",", "."));
  return Number.isFinite(value) ? value : null;
}
export function cleanToolNumber(value: number): number {
  return Object.is(value, -0) ? 0 : Number(value.toPrecision(14));
}
export function formatToolNumber(value: number, options?: Intl.NumberFormatOptions): string {
  if (!Number.isFinite(value)) return "—";
  const clean = cleanToolNumber(value);
  if (!options && clean !== 0 && (Math.abs(clean) >= 1e15 || Math.abs(clean) < 1e-8)) return clean.toExponential(6).replace(/\.?0+e/, "e");
  return new Intl.NumberFormat(undefined, options ?? { maximumSignificantDigits: 12 }).format(clean);
}

const DAY = 86400000;
/** Civil dates are represented as UTC day numbers, so daylight-saving transitions cannot change a day count. */
export function civilDay(input: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (year < 1 || year > 9999) return null;
  const date = new Date(0); date.setUTCHours(0, 0, 0, 0); date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.getTime() / DAY;
}
export function dayKey(day: number): string {
  const date = new Date(day * DAY), year = date.getUTCFullYear();
  if (!Number.isFinite(day) || !Number.isInteger(day) || year < 1 || year > 9999 || !Number.isFinite(year)) throw new Error("The resulting date must be between years 1 and 9999.");
  return `${String(year).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}
const weekday = (day: number) => ((day + 4) % 7 + 7) % 7;
const isWeekday = (day: number) => weekday(day) !== 0 && weekday(day) !== 6;
/** Signed weekdays, excluding the start and including the end, in either direction. */
export function weekdaysBetween(start: number, end: number): number {
  const distance = end - start, direction = Math.sign(distance), count = Math.abs(distance);
  const weeks = Math.floor(count / 7), remainder = count % 7;
  let weekdays = weeks * 5;
  for (let i = 1; i <= remainder; i++) if (isWeekday(start + direction * (weeks * 7 + i))) weekdays++;
  return direction * weekdays;
}
export type DateUnit = "days" | "weekdays" | "weeks" | "months" | "years";
/** Add civil days, weekdays, or calendar months/years, clamping a missing month day. */
export function addToDate(input: string, amount: number, unit: DateUnit): string {
  const start = civilDay(input);
  if (start === null) throw new Error("Choose a valid date.");
  if (!Number.isSafeInteger(amount) || Math.abs(amount) > 10000000) throw new Error("Enter a whole number within the supported date range.");
  let result = start;
  if (unit === "days" || unit === "weeks") result += amount * (unit === "weeks" ? 7 : 1);
  else if (unit === "weekdays" && amount) {
    const step = Math.sign(amount); let remaining = Math.abs(amount);
    // First reach a weekday; this also handles starts on weekends.
    while (remaining && !isWeekday(result += step)) { /* at most two weekend days */ }
    remaining--;
    const fullWeeks = Math.floor(remaining / 5); result += step * fullWeeks * 7; remaining %= 5;
    while (remaining) { result += step; if (isWeekday(result)) remaining--; }
  } else if (unit === "months" || unit === "years") {
    const original = new Date(start * DAY), month = (original.getUTCFullYear() - 1) * 12 + original.getUTCMonth() + amount * (unit === "years" ? 12 : 1);
    if (month < 0 || month >= 9999 * 12) throw new Error("The resulting date must be between years 1 and 9999.");
    const year = Math.floor(month / 12) + 1, monthIndex = month % 12;
    const last = new Date(0); last.setUTCHours(0, 0, 0, 0); last.setUTCFullYear(year, monthIndex + 1, 0);
    const next = new Date(0); next.setUTCHours(0, 0, 0, 0); next.setUTCFullYear(year, monthIndex, Math.min(original.getUTCDate(), last.getUTCDate()));
    result = next.getTime() / DAY;
  } else if (unit !== "weekdays") throw new Error("Choose a supported date unit.");
  return dayKey(result);
}

export function percentOf(percent: number, total: number): number { return finite(total * percent / 100); }
export function percentageOf(part: number, total: number): number { if (total === 0) throw new Error("Cannot divide by zero."); return finite(part / total * 100); }
export function percentageChange(from: number, to: number): number { if (from === 0) throw new Error("The starting value cannot be zero."); return finite((to - from) / Math.abs(from) * 100); }
export function adjustedByPercent(amount: number, percent: number): { increase: number; decrease: number } {
  return { increase: finite(amount * (1 + percent / 100)), decrease: finite(amount * (1 - percent / 100)) };
}
export function calculateTax(amount: number, rate: number, included: boolean): { net: number; tax: number; total: number } {
  if (rate < 0) throw new Error("Enter a non-negative tax rate.");
  const net = included ? finite(amount / (1 + rate / 100)) : amount;
  const total = included ? amount : finite(amount * (1 + rate / 100));
  return { net: finite(net), tax: finite(total - net), total: finite(total) };
}
function finite(value: number): number { if (!Number.isFinite(value)) throw new Error("The result is too large or undefined."); return value; }

export interface ConversionUnit { id: string; label: string; scale: number; offset?: number }
export interface ConversionCategory { id: string; label: string; from: string; to: string; units: ConversionUnit[]; note?: string }
const unit = (id: string, label: string, scale: number, offset?: number): ConversionUnit => ({ id, label, scale, offset });
/** Factors use SI definitions. Volume units explicitly distinguish US and Imperial measures. */
export const CONVERSION_CATEGORIES: ConversionCategory[] = [
  { id: "length", label: "Length", from: "cm", to: "in", units: [unit("mm", "Millimetres (mm)", .001), unit("cm", "Centimetres (cm)", .01), unit("m", "Metres (m)", 1), unit("km", "Kilometres (km)", 1000), unit("in", "Inches (in)", .0254), unit("ft", "Feet (ft)", .3048), unit("yd", "Yards (yd)", .9144), unit("mi", "Miles (mi)", 1609.344), unit("nmi", "Nautical miles", 1852)] },
  { id: "mass", label: "Weight & mass", from: "kg", to: "lb", units: [unit("mg", "Milligrams (mg)", .000001), unit("g", "Grams (g)", .001), unit("kg", "Kilograms (kg)", 1), unit("t", "Metric tonnes (t)", 1000), unit("oz", "Ounces (oz)", .028349523125), unit("lb", "Pounds (lb)", .45359237), unit("st", "Stones (st)", 6.35029318)] },
  { id: "area", label: "Area", from: "sqm", to: "sqft", units: [unit("sqcm", "Square centimetres", .0001), unit("sqm", "Square metres", 1), unit("sqkm", "Square kilometres", 1000000), unit("ha", "Hectares", 10000), unit("sqin", "Square inches", .00064516), unit("sqft", "Square feet", .09290304), unit("acre", "Acres", 4046.8564224)] },
  { id: "volume", label: "Volume", from: "l", to: "gal-us", note: "US and Imperial volume measures are different.", units: [unit("ml", "Millilitres (ml)", .001), unit("l", "Litres (L)", 1), unit("m3", "Cubic metres (m³)", 1000), unit("floz-us", "US fluid ounces", .0295735295625), unit("cup-us", "US cups", .2365882365), unit("pint-us", "US pints", .473176473), unit("qt-us", "US quarts", .946352946), unit("gal-us", "US gallons", 3.785411784), unit("gal-imp", "Imperial gallons", 4.54609)] },
  { id: "temperature", label: "Temperature", from: "c", to: "f", units: [unit("c", "Celsius (°C)", 1, 273.15), unit("f", "Fahrenheit (°F)", 5 / 9, 459.67 * 5 / 9), unit("k", "Kelvin (K)", 1, 0)] },
  { id: "time", label: "Time", from: "hour", to: "minute", units: [unit("ms", "Milliseconds", .001), unit("sec", "Seconds", 1), unit("minute", "Minutes", 60), unit("hour", "Hours", 3600), unit("day", "Days", 86400), unit("week", "Weeks", 604800)] },
  { id: "speed", label: "Speed", from: "kmh", to: "mph", units: [unit("ms", "Metres per second", 1), unit("kmh", "Kilometres per hour", 1000 / 3600), unit("mph", "Miles per hour", .44704), unit("kn", "Knots", 1852 / 3600)] },
  { id: "data", label: "Digital storage", from: "mb", to: "mib", note: "Decimal units use 1000; binary units use 1024.", units: [unit("b", "Bytes (B)", 1), unit("kb", "Kilobytes (kB)", 1000), unit("mb", "Megabytes (MB)", 1000000), unit("gb", "Gigabytes (GB)", 1000000000), unit("tb", "Terabytes (TB)", 1000000000000), unit("kib", "Kibibytes (KiB)", 1024), unit("mib", "Mebibytes (MiB)", 1048576), unit("gib", "Gibibytes (GiB)", 1073741824), unit("tib", "Tebibytes (TiB)", 1099511627776)] },
];
export function convertUnits(value: number, categoryId: string, fromId: string, toId: string): number {
  const category = CONVERSION_CATEGORIES.find((entry) => entry.id === categoryId);
  const from = category?.units.find((entry) => entry.id === fromId), to = category?.units.find((entry) => entry.id === toId);
  if (!from || !to) throw new Error("Choose valid units.");
  if (!Number.isFinite(value)) throw new Error("Enter a valid number.");
  return from === to ? value : finite((value * from.scale + (from.offset ?? 0) - (to.offset ?? 0)) / to.scale);
}
