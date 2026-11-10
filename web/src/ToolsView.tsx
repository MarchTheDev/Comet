import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft, ArrowLeftRight, ArrowRight, Calculator, CalendarDays, Copy,
  Delete, KeyRound, LockKeyhole, Percent, RefreshCw, Ruler, ShieldCheck, type LucideIcon,
} from "lucide-react";
import { AppSelect } from "./AppSelect";
import { ToolDateField } from "./ToolDateField";
import { dateKey } from "./utils/calendar";
import { APPLE_STYLE_ENTROPY, makeAppleStylePassword, makeCharacterPassword, makeWordPassphrase, passphraseEntropy, type CharacterOptions } from "./utils/toolPasswords";
import {
  addToDate, adjustedByPercent, calculateTax, civilDay, cleanToolNumber, CONVERSION_CATEGORIES, convertUnits,
  evaluateCalculation, formatToolNumber, parseToolNumber, percentOf, percentageChange, percentageOf, weekdaysBetween, type DateUnit,
} from "./utils/toolsMath";

export type ToolId = "calculator" | "password" | "date" | "percent" | "converter";
type Tool = { id: ToolId; title: string; description: string; detail: string; icon: LucideIcon };
const TOOLS: Tool[] = [
  { id: "calculator", title: "Calculator", description: "A little help with the numbers.", detail: "Do the math, without leaving your workspace.", icon: Calculator },
  { id: "password", title: "Password generator", description: "Create strong passwords and passphrases.", detail: "Generate a new password privately, right on this device.", icon: KeyRound },
  { id: "date", title: "Date calculator", description: "Count days or find a future date.", detail: "Find the time between dates, or add and subtract days.", icon: CalendarDays },
  { id: "percent", title: "Percent & tax", description: "Work out percentages, changes and VAT.", detail: "Everyday percentages and tax, made a little simpler.", icon: Percent },
  { id: "converter", title: "Unit converter", description: "Convert measurements in a moment.", detail: "Convert everyday measurements and digital storage.", icon: Ruler },
];

export function ToolsView({ active: controlled, onToolChange }: { active?: ToolId | null; onToolChange?: (tool: ToolId | null) => void } = {}) {
  const [localActive, setLocalActive] = useState<ToolId | null>(null);
  const active = controlled === undefined ? localActive : controlled;
  const root = useRef<HTMLElement>(null), previousTool = useRef<ToolId | null>(null);
  const tool = TOOLS.find((item) => item.id === active);
  useLayoutEffect(() => {
    if (active) root.current?.querySelector<HTMLElement>("#tools-title")?.focus();
    else if (previousTool.current) root.current?.querySelector<HTMLButtonElement>(`.tools-tile-${previousTool.current}`)?.focus();
    previousTool.current = active;
  }, [active]);
  const changeTool = (next: ToolId | null) => {
    if (onToolChange) onToolChange(next); else setLocalActive(next);
    const scroller = root.current?.closest<HTMLElement>(".workspace-scroll");
    if (scroller) scroller.scrollTop = 0;
  };
  return <section ref={root} className="tools-page" aria-labelledby="tools-title">
    {!tool ? <>
      <div className="tools-section-heading"><div><span className="tools-kicker">READY WHEN YOU ARE</span><h1 id="tools-title">Everyday tools</h1></div><span className="tools-count">05 TOOLS</span></div>
      <div className="tools-grid">
        {TOOLS.map(({ id, title, description, icon: Icon }, index) => <button type="button" className={`tools-tile tools-tile-${id}`} key={id} onClick={() => changeTool(id)}>
          <span className="tools-tile-top"><span className="tools-tile-icon"><Icon size={21} strokeWidth={1.8} aria-hidden="true" /></span><ArrowRight size={16} className="tools-tile-arrow" aria-hidden="true" /></span>
          <span className="tools-tile-copy"><strong>{title}</strong><small>{description}</small></span><span className="tools-tile-number">0{index + 1}</span>
        </button>)}
      </div>
      <div className="tools-privacy"><ShieldCheck size={17} aria-hidden="true" /><span><strong>Made for your workspace.</strong> These tools work offline; their inputs and results aren't saved by the tools.</span></div>
    </> : <>
      <button type="button" className="tools-back" onClick={() => changeTool(null)}><ArrowLeft size={15} /> All tools</button>
      <header className="tools-detail-heading"><span className="tools-detail-icon"><tool.icon size={22} aria-hidden="true" /></span><div><span className="tools-kicker">COMET TOOLS</span><h1 id="tools-title" tabIndex={-1}>{tool.title}</h1><p>{tool.detail}</p></div></header>
      {tool.id === "calculator" ? <CalculatorTool /> : tool.id === "password" ? <PasswordTool /> : tool.id === "date" ? <DateTool /> : tool.id === "percent" ? <PercentTool /> : <ConverterTool />}
    </>}
  </section>;
}

function SurfaceTitle({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) {
  return <div className="tool-surface-title"><div>{eyebrow && <span className="tools-kicker">{eyebrow}</span>}<h2>{title}</h2></div>{children}</div>;
}
function Field({ label, value, onChange, suffix, placeholder, type = "text", inputMode = "decimal", min, max }: { label: string; value: string; onChange: (value: string) => void; suffix?: string; placeholder?: string; type?: string; inputMode?: "decimal" | "numeric"; min?: string; max?: string }) {
  return <label className="tool-field"><span>{label}</span><span className="tool-input-wrap"><input aria-label={label} type={type} inputMode={inputMode} value={value} min={min} max={max} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} autoComplete="off" /><span className="tool-input-suffix">{suffix}</span></span></label>;
}
function SelectField({ label, value, onChange, children }: { label: string; value: string | number; onChange: (value: string) => void; children: ReactNode }) {
  return <div className="tool-field"><span>{label}</span><AppSelect label={label} value={value} onChange={onChange}>{children}</AppSelect></div>;
}
function Message({ children }: { children: ReactNode }) { return <p className="tool-message" role="status">{children}</p>; }

function CalculatorTool() {
  const [expression, setExpression] = useState("");
  const [history, setHistory] = useState<{ expression: string; result: string }[]>([]);
  const [error, setError] = useState("");
  const [finished, setFinished] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const preview = useMemo(() => { try { return expression.trim() ? formatToolNumber(evaluateCalculation(expression)) : "0"; } catch { return ""; } }, [expression]);
  // Start typing immediately on opening the calculator, without a separate click.
  useEffect(() => { input.current?.focus({ preventScroll: true }); }, []);
  const focusAt = (position: number) => requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(position, position); });
  const insert = (character: string) => {
    const reset = finished && /^[0-9.(]$/.test(character);
    const old = reset ? "" : expression;
    const start = reset ? 0 : input.current?.selectionStart ?? old.length, end = reset ? 0 : input.current?.selectionEnd ?? old.length;
    const next = old.slice(0, start) + character + old.slice(end);
    if (next.length <= 256) { setExpression(next); focusAt(start + character.length); }
    setFinished(false); setError("");
  };
  const backspace = () => {
    const start = input.current?.selectionStart ?? expression.length, end = input.current?.selectionEnd ?? expression.length;
    const from = start === end ? Math.max(0, start - 1) : start;
    setExpression(expression.slice(0, from) + expression.slice(end)); focusAt(from); setFinished(false); setError("");
  };
  const calculate = () => {
    try {
      const result = String(cleanToolNumber(evaluateCalculation(expression)));
      setHistory((items) => [{ expression, result }, ...items].slice(0, 20));
      setExpression(result); setError(""); setFinished(true); focusAt(result.length);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Check the expression and try again."); }
  };
  const buttons = [
    { label: "AC", action: () => { setExpression(""); setError(""); setFinished(false); focusAt(0); }, kind: "subtle" },
    { label: "(", value: "(", kind: "subtle" }, { label: ")", value: ")", kind: "subtle" },
    { label: "Backspace", action: backspace, kind: "subtle", icon: true },
    ...["7", "8", "9", "÷", "4", "5", "6", "×", "1", "2", "3", "−", "0", ".", "%", "+", "^"].map((value) => ({ label: value, value, kind: /[÷×−+%^]/.test(value) ? "operator" : "number" })),
    { label: "=", action: calculate, kind: "equals" },
  ];
  return <div className="tool-two-column calculator-layout">
    <div className="tool-surface calculator-surface">
      <SurfaceTitle eyebrow="YOUR SCRATCHPAD" title="Calculator" />
      <div className="calculator-display"><label htmlFor="tool-expression">EXPRESSION</label><input id="tool-expression" ref={input} value={expression} aria-label="Calculation expression" placeholder="0" maxLength={256} autoComplete="off" spellCheck={false} onChange={(event) => { setExpression(event.target.value); setFinished(false); setError(""); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === "=") { event.preventDefault(); event.stopPropagation(); calculate(); } else if (event.key === "Escape") { event.stopPropagation(); setExpression(""); setError(""); setFinished(false); } else if (finished && !event.ctrlKey && !event.metaKey && !event.altKey && /^[0-9.,(]$/.test(event.key)) { event.currentTarget.select(); } }} /><output aria-live="polite">{preview || " "}</output></div>
      {error && <Message>{error}</Message>}
      <div className="calculator-keys">{buttons.map((button) => <button type="button" key={button.label} className={`calculator-key ${button.kind}`} aria-label={button.label === "=" ? "Calculate" : button.label === "AC" ? "Clear calculation" : button.label} onMouseDown={(event) => event.preventDefault()} onClick={() => button.action ? button.action() : insert(button.value!)}>{button.icon ? <Delete size={19} /> : button.label}</button>)}</div>
    </div>
    <aside className="tool-surface calculator-history"><SurfaceTitle eyebrow="THIS SESSION" title="Recent calculations">{history.length > 0 && <button type="button" className="tool-text-button" onClick={() => setHistory([])}>Clear</button>}</SurfaceTitle>
      {history.length ? <div className="calculator-history-list">{history.map((item, index) => <button type="button" key={`${index}-${item.expression}`} onClick={() => { setExpression(item.expression); setFinished(false); setError(""); focusAt(item.expression.length); }}><span>{item.expression}</span><strong>= {formatToolNumber(Number(item.result))}</strong></button>)}</div> : <div className="tool-empty"><span><Calculator size={20} /></span><strong>Your calculations will appear here</strong><p>History stays in this view and clears when you leave it.</p></div>}
    </aside>
  </div>;
}

function PasswordTool() {
  const [mode, setMode] = useState<"apple" | "words" | "characters">("apple");
  const [wordCount, setWordCount] = useState(7), [separator, setSeparator] = useState("-"), [capitalize, setCapitalize] = useState(false), [digit, setDigit] = useState(false);
  const [length, setLength] = useState(24);
  const [options, setOptions] = useState<CharacterOptions>({ lowercase: true, uppercase: true, numbers: true, symbols: true });
  const [password, setPassword] = useState(""), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [pointerFocus, setPointerFocus] = useState(false);
  const output = useRef<HTMLTextAreaElement>(null), request = useRef(0);
  const generate = () => {
    request.current++;
    try {
      const value = mode === "apple" ? makeAppleStylePassword() : mode === "words" ? makeWordPassphrase(wordCount, separator, capitalize, digit) : makeCharacterPassword(length, options);
      setPassword(value); setError(""); setNotice("");
    } catch (failure) { setPassword(""); setError(failure instanceof Error ? failure.message : "Couldn't generate a password."); setNotice(""); }
  };
  useEffect(() => { generate(); }, [mode, wordCount, separator, capitalize, digit, length, options]);
  useLayoutEffect(() => {
    const area = output.current, container = area?.parentElement;
    if (!area || !container) return;
    const resize = () => { area.style.height = "auto"; area.style.height = `${Math.max(57, area.scrollHeight)}px`; };
    resize();
    let width = container.clientWidth;
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      if (container.clientWidth !== width) { width = container.clientWidth; resize(); }
    });
    observer?.observe(container); window.addEventListener("resize", resize);
    return () => { observer?.disconnect(); window.removeEventListener("resize", resize); };
  }, [password, mode]);
  const copy = async () => {
    const started = request.current;
    try {
      await navigator.clipboard.writeText(password);
      if (started === request.current) setNotice("Copied. Your system clipboard may retain it until you replace it.");
    } catch {
      if (started === request.current) { output.current?.focus(); output.current?.select(); setNotice("Couldn't access the clipboard. The password is selected so you can copy it manually."); }
    }
  };
  return <div className="tool-centered password-tool-layout">
    <div className="tool-surface">
      <SurfaceTitle eyebrow="GENERATED LOCALLY" title="Make a password" />
      <div className="tool-segments" role="group" aria-label="Password style">
        <button type="button" aria-pressed={mode === "apple"} onClick={() => setMode("apple")}>Grouped</button>
        <button type="button" aria-pressed={mode === "words"} onClick={() => setMode("words")}>Passphrase</button>
        <button type="button" aria-pressed={mode === "characters"} onClick={() => setMode("characters")}>Characters</button>
      </div>
      <div className="password-generator-result"><div className="password-result-top"><span>YOUR NEW PASSWORD</span><LockKeyhole size={14} aria-hidden="true" /></div><textarea ref={output} className={pointerFocus ? "pointer-focused" : ""} onPointerDown={() => setPointerFocus(true)} onBlur={() => setPointerFocus(false)} aria-label="Generated password" readOnly value={password} rows={mode === "words" && wordCount > 7 ? 3 : 2} spellCheck={false} autoComplete="off" /><div className="password-result-bottom"><span>{mode === "apple" ? `Approximately ${Math.floor(APPLE_STYLE_ENTROPY)} bits of randomness` : mode === "words" ? `Approximately ${Math.floor(passphraseEntropy(wordCount, digit))} bits of randomness` : "Securely generated on this device"}</span><button type="button" className="tool-copy-button" onClick={() => void copy()} disabled={!password}><Copy size={15} /> Copy</button></div></div>
      {error && <Message>{error}</Message>}{notice && <Message>{notice}</Message>}
      {mode === "words" ? <div className="tool-options">
        <div className="tool-field-row"><SelectField label="Number of words" value={wordCount} onChange={(value) => setWordCount(Number(value))}>{[4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => <option key={n} value={n}>{n} words</option>)}</SelectField><SelectField label="Word separator" value={separator} onChange={setSeparator}><option value="-">Hyphen ( - )</option><option value=" ">Space</option><option value=".">Period ( . )</option><option value="_">Underscore ( _ )</option></SelectField></div>
        <div className="tool-checks"><label><input type="checkbox" checked={capitalize} onChange={(event) => setCapitalize(event.target.checked)} /> Capitalize words</label><label><input type="checkbox" checked={digit} onChange={(event) => setDigit(event.target.checked)} /> Add a digit</label></div>
        {wordCount < 6 && <p className="tool-footnote">For sensitive accounts, consider six or more words; seven is the default.</p>}
      </div> : mode === "characters" ? <div className="tool-options"><label className="tool-range-label" htmlFor="password-length"><span>Length</span><strong>{length} characters</strong></label><input id="password-length" className="tool-range" type="range" min="12" max="64" value={length} onChange={(event) => setLength(Number(event.target.value))} />
        <div className="tool-checks">{([ ["lowercase", "Lowercase"], ["uppercase", "Uppercase"], ["numbers", "Numbers"], ["symbols", "Symbols"] ] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={options[key]} onChange={(event) => setOptions((current) => ({ ...current, [key]: event.target.checked }))} /> {label}</label>)}</div>
      </div> : null}
      <button type="button" className="primary-button tool-generate" onClick={generate}><RefreshCw size={15} /> Generate another</button>
    </div>
  </div>;
}

function DateTool() {
  const [today] = useState(() => dateKey(new Date()));
  const [start, setStart] = useState(today), [end, setEnd] = useState(today), [base, setBase] = useState(today), [amount, setAmount] = useState("30"), [unit, setUnit] = useState<DateUnit>("days");
  const [direction, setDirection] = useState<1 | -1>(1);
  const changeAmount = (value: string) => {
    const text = value.trimStart();
    if (text.startsWith("-")) { setDirection(-1); setAmount(text.slice(1)); }
    else if (text.startsWith("+")) { setDirection(1); setAmount(text.slice(1)); }
    else setAmount(value);
  };
  const startDay = civilDay(start), endDay = civilDay(end);
  const difference = startDay === null || endDay === null ? null : endDay - startDay;
  const business = startDay === null || endDay === null ? null : weekdaysBetween(startDay, endDay);
  let added = "", addError = "";
  try { const parsed = parseToolNumber(amount); if (parsed === null || !Number.isSafeInteger(parsed)) throw new Error("Enter a whole number."); added = addToDate(base, Math.abs(parsed) * direction, unit); }
  catch (failure) { addError = failure instanceof Error ? failure.message : "Choose a valid date."; }
  const formatDate = (key: string) => { const month = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key); return civilDay(key) === null || !month ? "—" : `${month[3]}/${month[2]}/${month[1]}`; };
  const formatWeekday = (key: string) => { const day = civilDay(key); return day === null ? "" : new Intl.DateTimeFormat(undefined, { weekday: "long", timeZone: "UTC" }).format(new Date(day * 86400000)); };
  return <div className="date-tool-grid">
    <div className="tool-surface"><SurfaceTitle eyebrow="COUNT THE DAYS" title="Between two dates" /><p className="tool-description">See how much time falls between a start and an end date.</p><div className="tool-field-row"><ToolDateField label="Start date" value={start} onChange={setStart} /><ToolDateField label="End date" value={end} onChange={setEnd} /></div>
      {difference === null ? <Message>Choose two valid dates between years 1 and 9999.</Message> : <div className="date-results" aria-live="polite"><div><strong>{formatToolNumber(Math.abs(difference))}</strong><span>calendar days</span></div><div><strong>{formatToolNumber(Math.abs(business!))}</strong><span>weekdays</span></div><p>{difference === 0 ? "The dates are the same." : difference > 0 ? "The end date is after the start date." : "The end date is before the start date."}</p></div>}
      <p className="tool-footnote">Weekdays are Monday–Friday, excluding the start date and including the end date. Public holidays aren't excluded.</p>
    </div>
    <div className="tool-surface"><SurfaceTitle eyebrow="LOOK AHEAD OR BACK" title="Add or subtract" /><p className="tool-description">Choose a direction, or type a negative number to go backwards.</p><div className="tool-segments date-direction" role="group" aria-label="Date direction"><button type="button" aria-pressed={direction === 1} onClick={() => setDirection(1)}>Add</button><button type="button" aria-pressed={direction === -1} onClick={() => setDirection(-1)}>Subtract</button></div><ToolDateField label="Starting date" value={base} onChange={setBase} /><div className="tool-field-row"><Field label="Amount" value={amount} onChange={changeAmount} placeholder="30" inputMode="numeric" /><SelectField label="Date unit" value={unit} onChange={(value) => setUnit(value as DateUnit)}><option value="days">Calendar days</option><option value="weekdays">Weekdays</option><option value="weeks">Weeks</option><option value="months">Months</option><option value="years">Years</option></SelectField></div>
      <div className="tool-result-block" aria-live="polite"><span>RESULTING DATE</span><strong>{added ? formatDate(added) : "—"}</strong><small>{added ? formatWeekday(added) : addError}</small></div><p className="tool-footnote">Weekdays skip weekends, not public holidays. Months and years use calendar dates; if a day doesn't exist in the target month, the last day is used.</p>
    </div>
  </div>;
}

function pairResult(first: string, second: string, operation: (a: number, b: number) => number, suffix = "") {
  const a = parseToolNumber(first), b = parseToolNumber(second);
  if (a === null || b === null) return "Enter valid numbers to see the result.";
  try { return `${formatToolNumber(operation(a, b))}${suffix}`; } catch (failure) { return failure instanceof Error ? failure.message : "Unable to calculate."; }
}
function PercentTool() {
  const [p, setP] = useState("15"), [total, setTotal] = useState("200");
  const [part, setPart] = useState("30"), [whole, setWhole] = useState("200");
  const [from, setFrom] = useState("100"), [to, setTo] = useState("120");
  const [base, setBase] = useState("100"), [adjustment, setAdjustment] = useState("10");
  const [taxAmount, setTaxAmount] = useState("100"), [taxRate, setTaxRate] = useState("20"), [included, setIncluded] = useState(false);
  const baseNumber = parseToolNumber(base), adjustmentNumber = parseToolNumber(adjustment);
  let adjusted: { increase: number; decrease: number } | null = null, adjustedError = "";
  try { if (baseNumber === null || adjustmentNumber === null) throw new Error("Enter valid numbers to see the result."); adjusted = adjustedByPercent(baseNumber, adjustmentNumber); }
  catch (failure) { adjustedError = failure instanceof Error ? failure.message : "Unable to calculate."; }
  const amount = parseToolNumber(taxAmount), rate = parseToolNumber(taxRate);
  let tax: { net: number; tax: number; total: number } | null = null, taxError = "";
  try { if (amount === null || rate === null) throw new Error("Enter valid numbers to see the result."); tax = calculateTax(amount, rate, included); }
  catch (failure) { taxError = failure instanceof Error ? failure.message : "Unable to calculate."; }
  const money = (value: number) => formatToolNumber(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return <div className="percent-tool-grid">
    <div className="tool-surface"><SurfaceTitle eyebrow="PERCENTAGE" title="Percent of a number" /><div className="tool-field-row"><Field label="Percentage" value={p} onChange={setP} suffix="%" /><Field label="Number" value={total} onChange={setTotal} /></div><div className="tool-inline-result"><span>RESULT</span><strong aria-live="polite">{pairResult(p, total, percentOf)}</strong></div></div>
    <div className="tool-surface"><SurfaceTitle eyebrow="PERCENTAGE" title="What percent is it?" /><div className="tool-field-row"><Field label="Part" value={part} onChange={setPart} /><Field label="Whole" value={whole} onChange={setWhole} /></div><div className="tool-inline-result"><span>RESULT</span><strong aria-live="polite">{pairResult(part, whole, percentageOf, "%")}</strong></div></div>
    <div className="tool-surface"><SurfaceTitle eyebrow="COMPARISON" title="Percentage change" /><div className="tool-field-row"><Field label="From" value={from} onChange={setFrom} /><Field label="To" value={to} onChange={setTo} /></div><div className="tool-inline-result"><span>CHANGE</span><strong aria-live="polite">{pairResult(from, to, percentageChange, "%")}</strong></div><p className="tool-footnote">Relative to the absolute starting value.</p></div>
    <div className="tool-surface"><SurfaceTitle eyebrow="ADJUSTMENT" title="Increase or decrease" /><div className="tool-field-row"><Field label="Starting amount" value={base} onChange={setBase} /><Field label="Adjustment" value={adjustment} onChange={setAdjustment} suffix="%" /></div><div className="tool-inline-result tool-inline-pair" aria-live="polite">{adjusted ? <><span>INCREASE <strong>{formatToolNumber(adjusted.increase)}</strong></span><span>DECREASE <strong>{formatToolNumber(adjusted.decrease)}</strong></span></> : <strong>{adjustedError}</strong>}</div></div>
    <div className="tool-surface tax-surface"><div><SurfaceTitle eyebrow="TAX & VAT" title="Add or remove tax" /><p className="tool-description">Calculate a total, or find the tax included in a price.</p><div className="tool-segments tax-segments" role="group" aria-label="Tax calculation"><button type="button" aria-pressed={!included} onClick={() => setIncluded(false)}>Add tax</button><button type="button" aria-pressed={included} onClick={() => setIncluded(true)}>Tax included</button></div><div className="tool-field-row"><Field label={included ? "Total including tax" : "Amount before tax"} value={taxAmount} onChange={setTaxAmount} /><Field label="Tax rate" value={taxRate} onChange={setTaxRate} suffix="%" /></div></div>
      <div className="tax-results" aria-live="polite">{tax ? <><div><span>Before tax</span><strong>{money(tax.net)}</strong></div><div><span>Tax</span><strong>{money(tax.tax)}</strong></div><div className="tax-total"><span>Total</span><strong>{money(tax.total)}</strong></div></> : <Message>{taxError}</Message>}<small>Amounts shown rounded to 2 decimals. Local tax rules may differ.</small></div>
    </div>
    <p className="tool-footnote percent-footnote">Use a comma or a period as the decimal separator. Don't include thousands separators.</p>
  </div>;
}

function ConverterTool() {
  const [categoryId, setCategoryId] = useState(CONVERSION_CATEGORIES[0].id);
  const [from, setFrom] = useState(CONVERSION_CATEGORIES[0].from), [to, setTo] = useState(CONVERSION_CATEGORIES[0].to), [value, setValue] = useState("1");
  const category = CONVERSION_CATEGORIES.find((item) => item.id === categoryId)!;
  const numeric = parseToolNumber(value);
  let converted: number | null = null, error = "";
  try { if (numeric === null) throw new Error("Enter a valid number."); converted = convertUnits(numeric, categoryId, from, to); }
  catch (failure) { error = failure instanceof Error ? failure.message : "Unable to convert."; }
  const swap = () => { if (converted !== null) setValue(String(cleanToolNumber(converted))); setFrom(to); setTo(from); };
  return <div className="tool-centered converter-layout"><div className="tool-surface"><SurfaceTitle eyebrow="A QUICK CONVERSION" title="Convert units" /><SelectField label="Measurement" value={categoryId} onChange={(id) => { const next = CONVERSION_CATEGORIES.find((item) => item.id === id); if (next) { setCategoryId(id); setFrom(next.from); setTo(next.to); } }}>{CONVERSION_CATEGORIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</SelectField>
    <div className="converter-fields"><div><Field label="Amount" value={value} onChange={setValue} /><SelectField label="From unit" value={from} onChange={setFrom}>{category.units.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</SelectField></div><button type="button" className="converter-swap" onClick={swap} aria-label="Swap units" title="Swap units"><ArrowLeftRight size={18} /></button><div><div className="converter-output"><span>RESULT</span><output aria-live="polite">{converted === null ? "—" : formatToolNumber(converted)}</output></div><SelectField label="To unit" value={to} onChange={setTo}>{category.units.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</SelectField></div></div>
    {error && <Message>{error}</Message>}<p className="tool-footnote">Use a comma or a period as the decimal separator. {category.note ?? "Results are rounded for display."}</p>
  </div></div>;
}
