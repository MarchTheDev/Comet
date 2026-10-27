import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, SlidersHorizontal } from "lucide-react";

export const PALETTE = ["#e5edf0", "#9fb4c0", "#e78383", "#efa768", "#e8cf72", "#8bc49f", "#78b5cf", "#9c9fe1", "#ca91c2", "#263f4f"];
interface Props { color: string; onChange: (color: string) => void; label: string; trigger?: ReactNode; preserveSelection?: boolean; onReset?: () => void }

/** An in-app popover can always be closed by pressing its trigger again, unlike
 * a platform-native color dialog. RGB sliders and hex input allow any color. */
export function ColorMenu({ color, onChange, label, trigger, preserveSelection, onReset }: Props) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState(color);
  const root = useRef<HTMLDivElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useEffect(() => { setDraft(color); }, [color]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node) && !popover.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape, true); };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = root.current?.getBoundingClientRect(); const panel = popover.current?.getBoundingClientRect();
      if (!trigger || !panel) return;
      const left = Math.max(8, Math.min(trigger.left, window.innerWidth - panel.width - 8));
      const top = trigger.bottom + 6 + panel.height > window.innerHeight - 8 ? Math.max(8, trigger.top - panel.height - 6) : trigger.bottom + 6;
      setPosition({ left, top });
    };
    place(); window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open, custom]);
  const safe = /^#[0-9a-f]{6}$/i.test(color) ? color : "#83b8ca";
  const channels = [1, 3, 5].map((index) => parseInt(safe.slice(index, index + 2), 16));
  const channel = (index: number, value: number) => {
    const values = [...channels]; values[index] = value;
    onChange(`#${values.map((part) => part.toString(16).padStart(2, "0")).join("")}`);
  };
  return <div className="color-menu-root" ref={root}>
    <button className="color-menu-trigger" type="button" aria-label={label} aria-expanded={open} title={label} onMouseDown={preserveSelection ? (event) => event.preventDefault() : undefined} onClick={() => setOpen((value) => !value)}>{trigger ?? <span className="color-current" style={{ background: safe }} />}</button>
    {open && createPortal(<div ref={popover} className="color-popover" role="group" aria-label={`${label} palette`} style={{ left: position.left, top: position.top }}>
      <div className="color-popover-heading">{label}<span>Choose a color</span></div>
      <div className="color-swatches">{PALETTE.map((swatch) => <button key={swatch} type="button" title={swatch} aria-label={`Choose ${swatch}`} aria-pressed={safe.toLowerCase() === swatch} style={{ background: swatch }} onMouseDown={preserveSelection ? (event) => event.preventDefault() : undefined} onClick={() => { onChange(swatch); setOpen(false); }}>{safe.toLowerCase() === swatch && <Check size={14} />}</button>)}</div>
      {onReset && <button type="button" className="color-reset" onMouseDown={preserveSelection ? (event) => event.preventDefault() : undefined} onClick={() => { onReset(); setOpen(false); }}>Use default color</button>}
      <button type="button" className="color-custom-toggle" aria-expanded={custom} onClick={() => setCustom((value) => !value)}><SlidersHorizontal size={14} /> Custom color</button>
      {custom && <div className="color-custom">
        <label>Hex <input aria-label={`${label} hex`} value={draft} maxLength={7} onChange={(event) => { const value = event.target.value; setDraft(value); if (/^#[0-9a-f]{6}$/i.test(value)) onChange(value); }} /></label>
        {(["Red", "Green", "Blue"] as const).map((name, index) => <label key={name}>{name}<input type="range" min="0" max="255" value={channels[index]} aria-label={`${label} ${name}`} onChange={(event) => channel(index, Number(event.target.value))} /><span>{channels[index]}</span></label>)}
      </div>}
    </div>, root.current?.closest('[role="dialog"]') ?? document.body)}
  </div>;
}
