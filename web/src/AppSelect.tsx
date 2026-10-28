import { Children, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

interface OptionProps { value?: string | number; children?: ReactNode; disabled?: boolean; hidden?: boolean }
interface Option { value: string; label: string; disabled: boolean; hidden: boolean }
interface Props {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}

/** A consistently themed, keyboard-operable select. The list is portalled so
 * scrollable toolbars and dialogs cannot clip it. Focus remains on the trigger. */
export function AppSelect({ label, value, onChange, children, disabled = false, className = "" }: Props) {
  const options: Option[] = Children.toArray(children).flatMap((child) => {
    if (!isValidElement<OptionProps>(child) || child.type !== "option") return [];
    const text = Children.toArray(child.props.children).map((part) => typeof part === "string" || typeof part === "number" ? String(part) : "").join("");
    return [{ value: String(child.props.value ?? text), label: text, disabled: !!child.props.disabled, hidden: !!child.props.hidden }];
  });
  const selected = options.find((option) => option.value === String(value));
  const visible = options.filter((option) => !option.hidden), enabled = visible.filter((option) => !option.disabled);
  const [open, setOpen] = useState(false), [active, setActive] = useState("");
  const [position, setPosition] = useState({ left: 8, top: 8, width: 180, maxHeight: 280 });
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const prefix = useId(), typeahead = useRef(""), typeTimer = useRef<number | null>(null);
  const optionId = (index: number) => `${prefix}-option-${index}`;
  const activeIndex = visible.findIndex((item) => item.value === active);
  const begin = (edge?: "first" | "last") => {
    if (disabled || !enabled.length) return;
    const first = edge === "last" ? enabled.at(-1)! : enabled[0];
    setActive(edge ? first.value : enabled.find((item) => item.value === String(value))?.value ?? first.value);
    setOpen(true);
  };
  const choose = (item: Option | undefined) => {
    if (!item || item.disabled) return;
    setOpen(false);
    if (item.value !== String(value)) onChange(item.value);
    trigger.current?.focus({ preventScroll: true });
  };
  const move = (step: number) => {
    if (!enabled.length) return;
    const index = enabled.findIndex((item) => item.value === active);
    setActive(enabled[(index < 0 ? (step > 0 ? 0 : enabled.length - 1) : (index + step + enabled.length) % enabled.length)].value);
  };
  const key = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Tab") { setOpen(false); return; }
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); return; }
    if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (!open) { begin(event.key === "Home" ? "first" : event.key === "End" ? "last" : undefined); return; }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") move(event.key === "ArrowDown" ? 1 : -1);
      else if (event.key === "Home" || event.key === "End") setActive((event.key === "Home" ? enabled[0] : enabled.at(-1))?.value ?? "");
      else choose(enabled.find((item) => item.value === active));
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); event.stopPropagation();
      if (typeTimer.current !== null) window.clearTimeout(typeTimer.current);
      typeahead.current += event.key.toLocaleLowerCase();
      typeTimer.current = window.setTimeout(() => { typeahead.current = ""; typeTimer.current = null; }, 700);
      const match = enabled.find((item) => item.label.trim().toLocaleLowerCase().startsWith(typeahead.current));
      if (match) { setActive(match.value); setOpen(true); }
    }
  };
  useEffect(() => () => { if (typeTimer.current !== null) window.clearTimeout(typeTimer.current); }, []);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { const target = event.target as Node; if (!trigger.current?.contains(target) && !panel.current?.contains(target)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect(), menu = panel.current;
      if (!anchor || !menu) return;
      const scale = Number(document.documentElement.style.zoom) || 1;
      const width = Math.min(Math.max(anchor.width, 165 * scale), window.innerWidth - 16);
      const height = Math.min(menu.scrollHeight * scale, 300 * scale, window.innerHeight - 16);
      const below = Math.max(0, window.innerHeight - anchor.bottom - 14), above = Math.max(0, anchor.top - 14);
      const flip = below < Math.min(height, 120 * scale) && above > below;
      const maxHeight = Math.max(40, Math.min(height, flip ? above : below));
      const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8));
      const top = flip ? Math.max(8, anchor.top - maxHeight - 6) : anchor.bottom + 6;
      setPosition({ left: left / scale, top: top / scale, width: width / scale, maxHeight: maxHeight / scale });
    };
    place(); window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, visible.length]);
  useEffect(() => { if (open && activeIndex >= 0) document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: "nearest" }); }, [active, activeIndex, open]);
  return <span className={`app-select-root ${className}`}>
    <button ref={trigger} type="button" role="combobox" className="app-select-trigger" aria-label={label} aria-expanded={open} aria-haspopup="listbox" aria-controls={open ? `${prefix}-list` : undefined} aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined} disabled={disabled} onClick={() => open ? setOpen(false) : begin()} onKeyDown={key}>
      <span>{selected?.label || "Choose…"}</span><ChevronDown size={15} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={panel} id={`${prefix}-list`} className="app-select-panel" role="listbox" aria-label={label} style={position} onPointerDown={(event) => event.stopPropagation()}>
      {visible.map((item, index) => <div key={`${item.value}:${index}`} id={optionId(index)} className={`app-select-option${item.value === active ? " is-active" : ""}`} role="option" aria-selected={item.value === String(value)} aria-disabled={item.disabled || undefined} onMouseDown={(event) => event.preventDefault()} onPointerMove={() => { if (!item.disabled) setActive(item.value); }} onClick={() => choose(item)}><span>{item.label}</span>{item.value === String(value) && <Check size={14} aria-hidden="true" />}</div>)}
    </div>, trigger.current?.closest('[role="dialog"]') ?? document.fullscreenElement ?? document.body)}
  </span>;
}
