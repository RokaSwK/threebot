import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Pipette } from "lucide-react";
import { hexToHsv, hsvToHex, normalizeHex } from "../../../server/avatar-color.mts";
import { recentColors } from "../lib/recentColors";
import "./color-picker.css";

type Hsv = { h: number; s: number; v: number };
/** A pasted hex colour: the whole text ("3fa7d6", "#3FA"), or the first "#rgb"/"#rrggbb" in it ("color: #3fa7d6;"). */
export function hexIn(text: string) {
  const match = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(text.trim()) ?? /#([0-9a-f]{6}|[0-9a-f]{3})(?![0-9a-z])/i.exec(text);
  return match ? normalizeHex(match[1]) : null;
}

type EyeDropperResult = { sRGBHex: string };
type EyeDropperCtor = new () => { open: () => Promise<EyeDropperResult> };
const eyeDropper = () => (typeof window !== "undefined" ? (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper : undefined);
// Chrome answers with hex; other engines may answer with rgb().
function pickedHex(value: string) {
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(value);
  return rgb ? `#${rgb.slice(1, 4).map(n => Number(n).toString(16).padStart(2, "0")).join("")}` : normalizeHex(value);
}

const clamp = (n: number, min = 0, max = 1) => Math.min(max, Math.max(min, n));
const percent = (n: number) => `${Math.round(n * 100)}%`;

/** Drag inside an element: calls `move` with the pointer's position as 0..1 fractions of its box. */
function useDrag(move: (x: number, y: number) => void) {
  const latest = useRef(move);
  latest.current = move;
  const [dragging, setDragging] = useState(false);
  const at = (e: PointerEvent<HTMLElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    latest.current(clamp((e.clientX - box.left) / box.width), clamp((e.clientY - box.top) / box.height));
  };
  return {
    dragging,
    handlers: {
      onPointerDown: (e: PointerEvent<HTMLElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.focus({ preventScroll: true });
        setDragging(true); at(e);
      },
      onPointerMove: (e: PointerEvent<HTMLElement>) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) at(e); },
      onPointerUp: () => setDragging(false),
      onPointerCancel: () => setDragging(false),
      onLostPointerCapture: () => setDragging(false),
    },
  };
}

/**
 * An inline colour picker: a saturation/brightness area, a hue slider, a hex field, the browser's
 * eyedropper where there is one, and recently saved colours. Every change goes to `onChange` as
 * "#rrggbb" so the avatar previews live; saving is up to the editor's Done.
 */
export function ColorPicker({ value, onChange, onClose, disabled = false, preview }: { value: string; onChange: (hex: string) => void; onClose?: () => void; disabled?: boolean; /** Shown beside the hex field, such as the avatar in this colour, so a phone sees it while the big one is scrolled away. */ preview?: ReactNode }) {
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
  const [text, setText] = useState(value);
  const [editing, setEditing] = useState(false);
  const [recent] = useState(recentColors);
  const hex = hsvToHex(hsv);
  // What this picker last sent: the value coming back is an echo, not a colour set from outside.
  const sent = useRef<string | null>(null);
  // Follow a colour set from outside (another swatch, Reset) without losing the hue of a gray.
  useEffect(() => {
    const incoming = normalizeHex(value);
    if (!incoming || incoming === sent.current || incoming === hex) return;
    const next = hexToHsv(incoming);
    setHsv(prev => ({ h: next.s === 0 || next.v === 0 ? prev.h : next.h, s: next.v === 0 ? prev.s : next.s, v: next.v }));
  }, [value]);
  useEffect(() => { if (!editing) setText(hex); }, [hex, editing]);

  // Dragging can fire faster than the avatars redraw: send at most one change per frame.
  const pending = useRef<string | null>(null);
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const emit = (next: string) => {
    pending.current = next;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => { frame.current = 0; if (pending.current) { sent.current = pending.current; onChange(pending.current); } });
  };
  // Updates go through the latest state, so several key presses within one frame all count.
  const set = (update: (prev: Hsv) => Hsv) => { if (!disabled) setHsv(prev => { const next = update(prev); emit(hsvToHex(next)); return next; }); };
  const setHex = (next: string | null) => {
    if (!next || disabled) return;
    const parsed = hexToHsv(next);
    setHsv(prev => ({ ...parsed, h: parsed.s === 0 ? prev.h : parsed.h }));
    setText(next);
    sent.current = next;
    onChange(next);
  };

  const area = useDrag((x, y) => set(prev => ({ ...prev, s: x, v: 1 - y })));
  const hue = useDrag((x) => set(prev => ({ ...prev, h: Math.min(x * 360, 359.9) })));
  const areaKeys = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.01;
    const moves: Record<string, (p: Hsv) => Partial<Hsv>> = { ArrowLeft: p => ({ s: clamp(p.s - step) }), ArrowRight: p => ({ s: clamp(p.s + step) }), ArrowUp: p => ({ v: clamp(p.v + step) }), ArrowDown: p => ({ v: clamp(p.v - step) }), Home: () => ({ s: 0 }), End: () => ({ s: 1 }), PageUp: () => ({ v: 1 }), PageDown: () => ({ v: 0 }) };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault(); set(prev => ({ ...prev, ...move(prev) }));
  };
  const hueKeys = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 15 : 1;
    const moves: Record<string, (h: number) => number> = { ArrowLeft: h => h - step, ArrowDown: h => h - step, ArrowRight: h => h + step, ArrowUp: h => h + step, Home: () => 0, End: () => 359, PageDown: h => h - 30, PageUp: h => h + 30 };
    const move = moves[e.key];
    if (!move) return;
    e.preventDefault(); set(prev => ({ ...prev, h: clamp(move(prev.h), 0, 359) }));
  };
  const typed = normalizeHex(text);
  const dropper = eyeDropper();
  const pick = async () => {
    if (!dropper) return;
    try { const result = await new dropper().open(); setHex(pickedHex(result.sRGBHex)); }
    catch { /* dismissed with Escape */ }
  };

  return <div className="color-picker" role="group" aria-label="Custom colour" onKeyDown={e => { if (e.key === "Escape" && onClose && !editing) { e.stopPropagation(); onClose(); } }}
    onPaste={e => { if ((e.target as HTMLElement).tagName === "INPUT") return; const pasted = hexIn(e.clipboardData.getData("text")); if (pasted) { e.preventDefault(); setHex(pasted); } }}>
    <div className="color-picker-field">
      <div className="color-picker-area" data-dragging={area.dragging || undefined} style={{ "--hue": `hsl(${hsv.h} 100% 50%)` } as CSSProperties} {...area.handlers}
        role="slider" tabIndex={disabled ? -1 : 0} aria-disabled={disabled || undefined} aria-label="Saturation and brightness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuetext={`Saturation ${percent(hsv.s)}, brightness ${percent(hsv.v)}`} onKeyDown={areaKeys}>
        <span className="color-picker-handle" style={{ left: percent(hsv.s), top: percent(1 - hsv.v), background: hex }} />
      </div>
      <div className="color-picker-hue" data-dragging={hue.dragging || undefined} {...hue.handlers}
        role="slider" tabIndex={disabled ? -1 : 0} aria-disabled={disabled || undefined} aria-label="Hue" aria-orientation="horizontal" aria-valuemin={0} aria-valuemax={359} aria-valuenow={Math.round(hsv.h)} aria-valuetext={`Hue ${Math.round(hsv.h)}°`} onKeyDown={hueKeys}>
        <span className="color-picker-handle" style={{ left: `${(hsv.h / 360) * 100}%`, background: `hsl(${hsv.h} 100% 50%)` }} />
      </div>
    </div>
    <div className="color-picker-side">
      <div className="color-picker-row">
        <label className="color-picker-hex" data-invalid={editing && !typed ? "" : undefined}>
          {preview ? <span className="color-picker-preview" aria-hidden="true">{preview}</span> : <span className="color-picker-chip" style={{ background: hex }} aria-hidden="true" />}
          <span className="sr-only">Hex colour</span>
          <span className="color-picker-hash" aria-hidden="true">#</span>
          <input value={text.replace(/^#/, "").toUpperCase()} disabled={disabled} maxLength={7} spellCheck={false} autoComplete="off" autoCapitalize="off" aria-invalid={editing && !typed}
            onFocus={e => { setEditing(true); e.currentTarget.select(); }}
            onChange={e => { const next = e.target.value; setText(next); const hex6 = /^#?[0-9a-f]{6}$/i.test(next.trim()) && normalizeHex(next); if (hex6) setHex(hex6); }}
            onPaste={e => { const pasted = hexIn(e.clipboardData.getData("text")); if (pasted) { e.preventDefault(); setHex(pasted); } }}
            onBlur={() => { setEditing(false); if (typed && typed !== hex) setHex(typed); else setText(hex); }}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); if (typed) setHex(typed); e.currentTarget.blur(); } if (e.key === "Escape") { e.stopPropagation(); setText(hex); e.currentTarget.blur(); } }} />
        </label>
        {dropper && <button type="button" className="color-picker-dropper" disabled={disabled} onClick={() => void pick()} aria-label="Pick a colour from the screen" title="Pick from the screen"><Pipette size={16} aria-hidden="true" /></button>}
      </div>
      {recent.length > 0 && <>
        <p className="color-picker-label" id="color-picker-recent">Recent</p>
        <div className="color-picker-recent" role="group" aria-labelledby="color-picker-recent">
          {recent.map(color => <button key={color} type="button" disabled={disabled} style={{ background: color }} aria-label={color} aria-pressed={color === hex} title={color.toUpperCase()} onClick={() => setHex(color)} />)}
        </div>
      </>}
    </div>
  </div>;
}
