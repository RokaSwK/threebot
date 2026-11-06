import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Camera, ChevronRight, ImageIcon, LoaderCircle, Plus, TriangleAlert } from "lucide-react";
import type { AvatarDefinition } from "open-bot-avatar";
import { Avatar } from "./Avatar";
import { Modal, Pill } from "./ui";
import { avatarShape, botColor, DEFAULT_AVATAR, PICKER_COLORS, PICKER_SHAPES } from "../lib/character";
import { importDefinition, OBJECT_AVATARS, objectShape } from "../lib/objectAvatars";
import type { Drawing } from "../lib/avatarDrawing";
import "./avatar-editor.css";

export type AvatarDraft = { shape: string; color: string; avatarImage?: string | null; avatarDefinition?: unknown };
export const resetAvatar = (): AvatarDraft => ({ ...DEFAULT_AVATAR, avatarImage: null, avatarDefinition: null });

/** A Bot drawing itself in the background: see useAvatarDrawing. */
export type DrawControls = {
  drawing: Drawing | null;
  start: (description: string) => void;
  retry: () => void;
  discard: () => void;
  use: (definition: AvatarDefinition) => Promise<void>;
};

type PickerProps = {
  choiceSize?: number; shape: string; color: string; disabled?: boolean;
  onChange: (shape: string, color: string, definition?: AvatarDefinition) => void;
  /** Objects other Bots have drawn, offered for reuse. */
  shared?: AvatarDefinition[];
  /** Asks the Bot to draw a new object from a description. Only offered for an existing Bot. */
  draw?: DrawControls;
};

export function AvatarPicker({ shape, color, onChange, disabled = false, shared = [], draw }: PickerProps) {
  const [open, setOpen] = useState(false);
  const drawing = draw?.drawing ?? null;
  const tile = (object: AvatarDefinition, own: boolean) => <button type="button" disabled={disabled} key={`${own ? "shared" : "gallery"}-${object.id}`} className="avatar-tile avatar-object" aria-label={object.name} title={object.name} aria-pressed={shape === objectShape(object.id)} onClick={() => onChange(objectShape(object.id), color, own ? object : undefined)}>
    <Avatar shape={objectShape(object.id)} color={color} definition={own ? object : undefined} size={40} still />
  </button>;
  return <fieldset disabled={disabled} className="avatar-picker">
    <legend className="sr-only">Choose an avatar</legend>
    <div className="avatar-shapes">
      {PICKER_SHAPES.map(s => <button type="button" disabled={disabled} key={s} className="avatar-tile avatar-choice" data-shape={s} onClick={() => onChange(s, color)} aria-label={s === "t3" ? "T3 avatar" : `${s} shape`} aria-pressed={avatarShape(shape) === s}>
        <Avatar shape={s} color={color} size={64} />
      </button>)}
    </div>
    <p className="avatar-section-title">Objects</p>
    <div className="avatar-objects">{OBJECT_AVATARS.map(object => tile(object, false))}</div>
    {(shared.length > 0 || draw) && <>
      <p className="avatar-section-title">Drawn by your Bots</p>
      <div className="avatar-objects avatar-drawn">
        {shared.map(object => tile(object, true))}
        {draw && <DrawTile drawing={drawing} color={color} open={open} disabled={disabled} onToggle={() => setOpen(value => !value)} />}
      </div>
      {draw && (drawing || open) && <DrawPanel draw={draw} color={color} disabled={disabled} onClose={() => setOpen(false)} />}
    </>}
    <div className="avatar-colors">
      {PICKER_COLORS.map(c => <button key={c.id} type="button" disabled={disabled} onClick={() => onChange(shape, c.id)} style={{ background: botColor(c.id) }} aria-label={c.name} aria-pressed={color === c.id} />)}
    </div>
  </fieldset>;
}

/** The "+" tile, which stands for the drawing once one is under way. */
function DrawTile({ drawing, color, open, disabled, onToggle }: { drawing: Drawing | null; color: string; open: boolean; disabled: boolean; onToggle: () => void }) {
  if (!drawing) return <button type="button" disabled={disabled} className="avatar-tile avatar-object avatar-object-new" aria-label="Draw a new object" title="Draw a new object" aria-expanded={open} onClick={onToggle}><Plus size={20} aria-hidden="true" /></button>;
  if (drawing.status === "ready") return <span className="avatar-tile avatar-object avatar-object-draft" role="img" aria-label={`Drawing ready: ${drawing.definition.name}`} title={drawing.definition.name}><Avatar shape={objectShape(drawing.definition.id)} color={color} definition={drawing.definition} size={40} still /></span>;
  if (drawing.status === "failed") return <span className="avatar-tile avatar-object avatar-object-draft" data-failed role="img" aria-label="Drawing failed"><TriangleAlert size={18} aria-hidden="true" /></span>;
  return <span className="avatar-tile avatar-object avatar-object-draft" data-pending role="img" aria-label="Drawing"><LoaderCircle size={20} className="animate-spin" aria-hidden="true" /></span>;
}

function useElapsed(since: string | undefined, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!running) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [running]);
  const seconds = since ? Math.max(0, Math.floor((now - Date.parse(since)) / 1000)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function DrawPanel({ draw, color, disabled, onClose }: { draw: DrawControls; color: string; disabled: boolean; onClose: () => void }) {
  const { drawing } = draw;
  const [description, setDescription] = useState("");
  const [using, setUsing] = useState(false);
  const [error, setError] = useState("");
  const busy = drawing?.status === "drawing" || drawing?.status === "checking";
  const elapsed = useElapsed(drawing?.thread?.createdAt, busy);
  const submit = () => { const text = description.trim(); if (!text) return; draw.start(text); setDescription(""); };
  const use = async (definition: AvatarDefinition) => {
    setUsing(true); setError("");
    try { await draw.use(definition); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't use this avatar"); }
    finally { setUsing(false); }
  };
  if (!drawing) return <form className="avatar-draw" onSubmit={e => { e.preventDefault(); submit(); }}>
    <input aria-label="Describe the new object" autoFocus value={description} disabled={disabled} maxLength={200} onChange={e => setDescription(e.target.value)} onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }} placeholder="Describe it, like a fox with a scarf" />
    <Pill variant="ghost" disabled={disabled} onClick={onClose}>Cancel</Pill>
    <Pill type="submit" disabled={disabled || !description.trim()}>Draw it</Pill>
  </form>;
  const quoted = drawing.description ? `“${drawing.description}”` : "your object";
  return <div className="avatar-draw-card" role="status" aria-live="polite">
    <span className="avatar-draw-preview">
      {drawing.status === "ready" ? <Avatar shape={objectShape(drawing.definition.id)} color={color} definition={drawing.definition} size={64} state="happy" />
        : drawing.status === "failed" ? <TriangleAlert size={22} aria-hidden="true" />
        : <LoaderCircle size={24} className="animate-spin" aria-hidden="true" />}
    </span>
    <span className="avatar-draw-text">
      {drawing.status === "ready" ? <><strong>{drawing.definition.name}</strong><span>Drawn from {quoted}. Use it to make it this Bot's avatar.</span></>
        : drawing.status === "failed" ? <><strong>Couldn't draw {quoted}</strong><span className="avatar-draw-error">{error || drawing.error}</span></>
        : <><strong>Drawing {quoted}</strong><span>{drawing.status === "checking" ? "Checking the drawing…" : `${elapsed} · In the background, not in your chat`}</span></>}
      {error && drawing.status !== "failed" && <span className="avatar-draw-error" role="alert">{error}</span>}
      {busy && <span className="avatar-draw-progress" aria-hidden="true" />}
    </span>
    <span className="avatar-draw-actions">
      {busy ? <Pill variant="ghost" disabled={disabled || !drawing.thread} onClick={draw.discard}>Stop</Pill> : <>
        <Pill variant="ghost" disabled={disabled || using} onClick={draw.discard}>Discard</Pill>
        {drawing.description && <Pill variant="soft" disabled={disabled || using} onClick={draw.retry}>Try again</Pill>}
        {drawing.status === "ready" && <Pill disabled={disabled || using} onClick={() => void use(drawing.definition)}>Use</Pill>}
      </>}
    </span>
  </div>;
}

type Crop = { source: HTMLImageElement; zoom: number; x: number; y: number };
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function AvatarImport({ color, disabled, onImport }: { color: string; disabled: boolean; onImport: (draft: AvatarDraft) => void }) {
  const [json, setJson] = useState("");
  const [error, setError] = useState("");
  const use = () => {
    const result = importDefinition(json);
    if (!result.ok) return setError(result.error);
    setError(""); setJson("");
    onImport({ shape: objectShape(result.definition.id), color, avatarImage: null, avatarDefinition: result.definition });
  };
  return <details className="avatar-import">
    <summary>Import an avatar</summary>
    <p>Paste <a href="https://dominikscholz.github.io/open-bot-avatar/" target="_blank" rel="noreferrer">Open Bot Avatar</a> JSON, or ask your Bot to draw itself.</p>
    <textarea aria-label="Avatar JSON" rows={3} value={json} disabled={disabled} onChange={e => { setJson(e.target.value); setError(""); }} placeholder='{"version":1,"id":"box", ...}' />
    {error && <p role="alert" className="avatar-editor-error">{error}</p>}
    <Pill variant="soft" disabled={disabled || !json.trim()} onClick={use}>Use this avatar</Pill>
  </details>;
}

export function AvatarEditor({ value, onChange, disabled = false, onPendingChange, shared, draw }: { value: AvatarDraft; onChange: (value: AvatarDraft) => void; disabled?: boolean; onPendingChange?: (pending: boolean) => void; shared?: AvatarDefinition[]; draw?: DrawControls }) {
  const [tab, setTab] = useState<"bot" | "upload">("bot");
  const [crop, setCrop] = useState<Crop | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const version = useRef(0);
  const drag = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null);
  useEffect(() => () => { version.current++; }, []);
  useEffect(() => { onPendingChange?.(loading || crop !== null); }, [loading, crop, onPendingChange]);
  const load = async (file: File | undefined) => {
    if (!file || disabled) return;
    const current = ++version.current;
    setError(""); setLoading(true);
    let url: string | undefined;
    try {
      if (file.size > MAX_IMAGE_BYTES) throw Error("Choose an image smaller than 25 MB");
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) throw Error("That image could not be loaded");
      url = URL.createObjectURL(file);
      const source = new Image(); source.src = url;
      await source.decode();
      if (!source.naturalWidth || source.naturalWidth * source.naturalHeight > 40_000_000) throw Error("That image could not be loaded");
      // A decoded data URL keeps the crop independent of the file input/object URL.
      const reader = new FileReader();
      const data = await new Promise<string>((resolve, reject) => { reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(Error("That file could not be read")); reader.onerror = () => reject(Error("That file could not be read")); reader.readAsDataURL(file); });
      source.src = data; await source.decode();
      if (current === version.current) { setCrop({ source, zoom: 1, x: 0, y: 0 }); setTab("upload"); }
    } catch (cause) { if (current === version.current) setError(cause instanceof Error ? cause.message : "That image could not be loaded"); }
    finally { if (url) URL.revokeObjectURL(url); if (current === version.current) setLoading(false); }
  };
  const limitCrop = (next: Crop): Crop => {
    const min = Math.min(next.source.naturalWidth, next.source.naturalHeight);
    const maxX = (next.source.naturalWidth * next.zoom / min - 1) / 2;
    const maxY = (next.source.naturalHeight * next.zoom / min - 1) / 2;
    return { ...next, x: Math.max(-maxX, Math.min(maxX, next.x)), y: Math.max(-maxY, Math.min(maxY, next.y)) };
  };
  const setAvatar = () => {
    if (!crop) return;
    try {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1024;
      const ctx = canvas.getContext("2d"); if (!ctx) throw Error("Could not export the avatar");
      const scale = 1024 * crop.zoom / Math.min(crop.source.naturalWidth, crop.source.naturalHeight);
      const w = crop.source.naturalWidth * scale, h = crop.source.naturalHeight * scale;
      ctx.drawImage(crop.source, (1024 - w) / 2 + crop.x * 1024, (1024 - h) / 2 + crop.y * 1024, w, h);
      onChange({ ...value, avatarImage: canvas.toDataURL("image/png") }); setCrop(null);
    } catch { setError("Could not export the avatar"); }
  };
  const reset = () => { version.current++; setLoading(false); setCrop(null); setError(""); onChange(resetAvatar()); };
  const tabs = <div className="avatar-tabs" role="tablist" aria-label="Avatar source">
    <button type="button" role="tab" aria-selected={tab === "bot"} disabled={disabled} onClick={() => { version.current++; setLoading(false); setCrop(null); setTab("bot"); }}><span className="avatar-desktop">Bot</span><span className="avatar-mobile">Shape</span></button>
    <button type="button" role="tab" aria-selected={tab === "upload"} disabled={disabled} onClick={() => setTab("upload")}>Upload</button>
  </div>;
  return <div className="avatar-editor" onPaste={e => { const file = Array.from(e.clipboardData.files).find(f => f.type.startsWith("image/")); if (file) { e.preventDefault(); void load(file); } }}>
    <div className="avatar-mobile avatar-mobile-tabs">{tabs}</div>
    <div className="avatar-editor-preview" aria-label="Avatar preview"><Avatar shape={value.shape} color={value.color} picture={value.avatarImage} definition={value.avatarDefinition} size={112} /></div>
    <div className="avatar-editor-card">
      <div className="avatar-desktop avatar-card-header">{tabs}<button type="button" disabled={disabled} onClick={reset}>Reset</button></div>
      {tab === "bot" ? <AvatarPicker shape={value.shape} color={value.color} disabled={disabled} shared={shared} draw={draw} onChange={(shape, color, definition) => onChange({ shape, color, avatarImage: null, avatarDefinition: definition ?? (shape === value.shape ? value.avatarDefinition : null) })} /> : <div className={clsx("avatar-upload", loading && "opacity-50")} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void load(e.dataTransfer.files[0]); }}>
        {crop ? <>
          <div className="avatar-crop" aria-label="Drag to reposition" onPointerDown={e => { if (disabled) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, y: e.clientY, startX: crop.x, startY: crop.y }; }} onPointerMove={e => { if (!drag.current) return; const size = e.currentTarget.clientWidth; setCrop(limitCrop({ ...crop, x: drag.current.startX + (e.clientX - drag.current.x) / size, y: drag.current.startY + (e.clientY - drag.current.y) / size })); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
            <img draggable={false} alt="" src={crop.source.src} style={{ width: `${100 * crop.source.naturalWidth / Math.min(crop.source.naturalWidth, crop.source.naturalHeight) * crop.zoom}%`, maxWidth: "none", transform: `translate(calc(-50% + ${crop.x * 240}px), calc(-50% + ${crop.y * 240}px))` }} />
          </div>
          <p>Drag to reposition</p>
          <label className="avatar-zoom">Zoom<input aria-label="Zoom" type="range" min="1" max="4" step="0.01" value={crop.zoom} disabled={disabled} onChange={e => setCrop(limitCrop({ ...crop, zoom: Number(e.target.value) }))} /></label>
          <div className="flex justify-center gap-2"><Pill variant="soft" disabled={disabled} onClick={() => setCrop(null)}>Cancel</Pill><Pill disabled={disabled} onClick={setAvatar}>Set avatar</Pill></div>
        </> : <>
          <div className="avatar-desktop avatar-drop"><p>Drag, drop, or paste an image</p><span>or</span><Pill variant="soft" disabled={disabled || loading} onClick={() => input.current?.click()}>Browse files</Pill></div>
          <div className="avatar-mobile avatar-photo-actions"><button type="button" disabled={disabled || loading} onClick={() => input.current?.click()}><ImageIcon size={20} aria-hidden="true" /><span>Choose from Photos</span><ChevronRight size={18} aria-hidden="true" /></button><button type="button" disabled={disabled || loading} onClick={() => camera.current?.click()}><Camera size={20} aria-hidden="true" /><span>Take Photo</span><ChevronRight size={18} aria-hidden="true" /></button></div>
          <p className="avatar-mobile avatar-upload-hint">Images up to 25 MB. You can crop it next.</p>
        </>}
        <input ref={input} hidden aria-label="Browse files" type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={disabled} onChange={e => { void load(e.target.files?.[0]); e.target.value = ""; }} />
        <input ref={camera} hidden aria-label="Take Photo" type="file" accept="image/*" capture="environment" disabled={disabled} onChange={e => { void load(e.target.files?.[0]); e.target.value = ""; }} />
      </div>}
      {tab === "bot" && <AvatarImport color={value.color} disabled={disabled} onImport={onChange} />}
      {tab === "bot" && <button type="button" className="avatar-mobile avatar-reset" disabled={disabled} onClick={reset}>Reset to default</button>}
    </div>
    {error && <p role="alert" className="avatar-editor-error">{error}</p>}
  </div>;
}

export function AvatarEditorDialog({ initial, onSave, onClose, shared, draw }: { initial: AvatarDraft; onSave: (draft: AvatarDraft) => Promise<void>; onClose: () => void; shared?: AvatarDefinition[]; draw?: Omit<DrawControls, "use"> }) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const changed = draft.shape !== initial.shape || draft.color !== initial.color || (draft.avatarImage ?? null) !== (initial.avatarImage ?? null) || (draft.avatarDefinition ?? null) !== (initial.avatarDefinition ?? null);
  const close = () => { if (!saving) onClose(); };
  const save = async () => {
    if (saving || pending) return;
    if (!changed) { close(); return; }
    setSaving(true); setError("");
    try { await onSave(draft); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't save the avatar"); setSaving(false); }
  };
  // Use saves the drawing straight to the Bot (with the colour picked here) and clears the job.
  const use = async (definition: AvatarDefinition) => {
    const next = { shape: objectShape(definition.id), color: draft.color, avatarImage: null, avatarDefinition: definition };
    await onSave(next);
    setDraft(next);
    draw?.discard();
  };
  return <Modal title="Avatar" className="avatar-editor-sheet w-[560px]" onClose={close} onBack={close} headerActions={<Pill disabled={saving || pending} onClick={() => void save()}>Done</Pill>}>
    <div className="dialog-body"><AvatarEditor value={draft} onChange={setDraft} disabled={saving} onPendingChange={setPending} shared={shared} draw={draw && { ...draw, use }} />{error && <p role="alert" className="avatar-editor-error">{error}</p>}</div>
  </Modal>;
}
