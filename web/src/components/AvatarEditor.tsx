import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import clsx from "clsx";
import { Camera, ChevronRight, ImageIcon, LoaderCircle, Plus, TriangleAlert, X } from "lucide-react";
import type { AvatarDefinition } from "open-bot-avatar";
import { Avatar } from "./Avatar";
import { IconButton, Modal, Pill } from "./ui";
import { avatarShape, botColor, DEFAULT_AVATAR, isCustomColor, PICKER_COLORS, PICKER_SHAPES } from "../lib/character";
import { colorHex } from "../../../server/avatar-color.mts";
import { ColorPicker } from "./ColorPicker";
import { importDefinition, OBJECT_AVATARS, objectShape } from "../lib/objectAvatars";
import type { Drawing, DrawingOption } from "../lib/avatarDrawing";
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
  /** Asks for a new object from a description. Only offered for an existing Bot. */
  draw?: DrawControls;
  /** Small labels over every group, as in the avatar editor. */
  labels?: boolean;
  /** The drawn option being looked at before Use, or null when the choice is the shape itself. */
  onPreview?: (definition: AvatarDefinition | null) => void;
};

const busyOption = (option: DrawingOption) => option.status === "drawing" || option.status === "checking" || option.status === "fixing";

export function AvatarPicker({ shape, color, onChange, disabled = false, shared = [], draw, labels = false, onPreview }: PickerProps) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState(0);
  // A drawn option is selected until another shape is picked: the shape it was picked over, or null.
  const [optionOver, setOptionOver] = useState<string | null>(shape);
  const custom = isCustomColor(color);
  const [picking, setPicking] = useState(false);
  // A colour picked that is exactly a palette swatch is stored by its name, except black: the black
  // swatch turns white in dark mode, and a picked #000000 means black.
  const pickColor = (hex: string) => onChange(shape, PICKER_COLORS.find(c => c.id !== "black" && c.value.toLowerCase() === hex)?.id ?? hex);
  const drawing = draw?.drawing ?? null;
  const options = drawing?.options ?? [];
  // The chosen option, or the first one that is ready.
  const ready = options.findIndex((option) => option.status === "ready");
  const pick = options[chosen]?.status === "ready" ? chosen : ready >= 0 ? ready : chosen;
  const picked = options[pick];
  // One selection at a time: a picked drawing, or the shape, object or saved drawing it would replace.
  const previewed = optionOver === shape && picked?.status === "ready" ? picked.definition : null;
  useEffect(() => { onPreview?.(previewed); }, [previewed, onPreview]);
  useEffect(() => () => onPreview?.(null), [onPreview]);
  const choose = (next: string, definition?: AvatarDefinition) => { setOptionOver(null); if (definition) onChange(next, color, definition); else onChange(next, color); };
  const drawControls = draw && { ...draw, start: (description: string) => { setOptionOver(shape); setChosen(0); draw.start(description); }, retry: () => { setOptionOver(shape); setChosen(0); draw.retry(); } };
  const tile = (object: AvatarDefinition, own: boolean) => <button type="button" disabled={disabled} key={`${own ? "shared" : "gallery"}-${object.id}`} className="avatar-tile avatar-object" aria-label={object.name} title={object.name} aria-pressed={!previewed && shape === objectShape(object.id)} onClick={() => choose(objectShape(object.id), own ? object : undefined)}>
    <Avatar shape={objectShape(object.id)} color={color} definition={own ? object : undefined} size={40} still />
  </button>;
  return <fieldset disabled={disabled} className={clsx("avatar-picker", labels && "avatar-picker-labelled")}>
    <legend className="sr-only">Choose an avatar</legend>
    {labels && <p className="avatar-section-title" aria-hidden="true">Shape</p>}
    <div className="avatar-shapes">
      {PICKER_SHAPES.map(s => <button type="button" disabled={disabled} key={s} className="avatar-tile avatar-choice" data-shape={s} onClick={() => choose(s)} aria-label={s === "t3" ? "T3 avatar" : `${s} shape`} aria-pressed={!previewed && avatarShape(shape) === s}>
        <Avatar shape={s} color={color} size={64} />
      </button>)}
    </div>
    <p className="avatar-section-title">Objects</p>
    <div className="avatar-objects">{OBJECT_AVATARS.map(object => tile(object, false))}</div>
    {(shared.length > 0 || draw) && <>
      <p className="avatar-section-title">Drawn by your Bots</p>
      <div className="avatar-objects avatar-drawn">
        {shared.map(object => tile(object, true))}
        {draw && (drawing ? (options.length ? options : [{ status: "drawing" } as DrawingOption]).map((option, index) =>
          <OptionTile key={option.thread?.id ?? index} option={option} index={index} count={Math.max(options.length, 1)} color={color} chosen={!!previewed && index === pick} disabled={disabled} onChoose={() => { setChosen(index); setOptionOver(shape); }} />)
          : <button type="button" disabled={disabled} className="avatar-tile avatar-object avatar-object-new" aria-label="Draw a new object" title="Draw a new object" aria-expanded={open} onClick={() => setOpen(value => !value)}><Plus size={20} aria-hidden="true" /></button>)}
      </div>
      {drawControls && (drawing || open) && <DrawPanel draw={drawControls} chosen={picked} color={color} disabled={disabled} onClose={() => setOpen(false)} />}
    </>}
    {labels && <p className="avatar-section-title" aria-hidden="true">Colour</p>}
    <div className="avatar-colors">
      {PICKER_COLORS.map(c => <button key={c.id} type="button" disabled={disabled} onClick={() => { setPicking(false); onChange(shape, c.id); }} style={{ background: botColor(c.id) }} aria-label={c.name} aria-pressed={color === c.id} />)}
      <button type="button" className="avatar-color-custom" disabled={disabled} data-custom={custom || undefined} onClick={() => setPicking(value => !value)}
        aria-label={custom ? `Custom colour ${color.toUpperCase()}` : "Custom colour"} aria-pressed={custom} aria-expanded={picking} title="Custom colour"
        style={custom ? { "--custom-fill": color } as CSSProperties : undefined}>
        <span>{!custom && <Plus aria-hidden="true" />}</span>
      </button>
    </div>
    {picking && <ColorPicker value={colorHex(color)} disabled={disabled} onChange={pickColor} onClose={() => setPicking(false)}
      preview={<Avatar shape={shape} color={color} size={28} still />} />}
  </fieldset>;
}

/** One option of a drawing: a spinner while it draws, then the drawing to pick. */
function OptionTile({ option, index, count, color, chosen, disabled, onChoose }: { option: DrawingOption; index: number; count: number; color: string; chosen: boolean; disabled: boolean; onChoose: () => void }) {
  const label = count > 1 ? `Option ${index + 1} of ${count}` : "Drawing";
  if (option.status === "ready") return <button type="button" disabled={disabled} className="avatar-tile avatar-object avatar-object-draft" data-ready aria-pressed={chosen} aria-label={`${label}: ${option.definition.name}`} title={option.definition.name} onClick={onChoose}>
    <Avatar shape={objectShape(option.definition.id)} color={color} definition={option.definition} size={40} still />
  </button>;
  if (option.status === "failed") return <span className="avatar-tile avatar-object avatar-object-draft" data-failed role="img" aria-label={`${label}: couldn't draw it`} title={option.error}><TriangleAlert size={18} aria-hidden="true" /></span>;
  return <span className="avatar-tile avatar-object avatar-object-draft" data-pending role="img" aria-label={`${label}: ${option.status === "fixing" ? "fixing" : "drawing"}`}><LoaderCircle size={20} className="animate-spin" aria-hidden="true" /></span>;
}

function useElapsed(since: string | undefined, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!running) return; setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [running]);
  const seconds = since ? Math.max(0, Math.floor((now - Date.parse(since)) / 1000)) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function DrawPanel({ draw, chosen, color, disabled, onClose }: { draw: DrawControls; chosen?: DrawingOption; color: string; disabled: boolean; onClose: () => void }) {
  const { drawing } = draw;
  const [description, setDescription] = useState("");
  const [using, setUsing] = useState(false);
  const [error, setError] = useState("");
  const options = drawing?.options ?? [];
  const busy = !!drawing && !drawing.error && (!options.length || options.some(busyOption));
  const elapsed = useElapsed(drawing?.startedAt, busy);
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
  const done = options.filter((option) => option.status === "ready").length;
  const failure = drawing.error ?? (options.length && options.every((option) => option.status === "failed") ? (options[0] as Extract<DrawingOption, { status: "failed" }>).error : "");
  const ready = chosen?.status === "ready" ? chosen.definition : null;
  return <div className="avatar-draw-card" role="status" aria-live="polite">
    <span className="avatar-draw-preview">
      {ready ? <Avatar shape={objectShape(ready.id)} color={color} definition={ready} size={56} />
        : failure ? <TriangleAlert size={22} aria-hidden="true" />
        : <LoaderCircle size={22} className="animate-spin" aria-hidden="true" />}
    </span>
    <span className="avatar-draw-text">
      {failure ? <><strong>Couldn't draw {quoted}</strong><span className="avatar-draw-error">{error || failure}</span></>
        : ready ? <><strong>{ready.name}</strong><span>{busy ? `${done} of ${options.length} ready · ${elapsed}` : options.length > 1 ? "Pick one, then Use it." : "Use it to make it this Bot's avatar."}</span></>
        : <><strong>Drawing {quoted}</strong><span>{options.some((option) => option.status === "fixing") ? `Fixing a drawing · ${elapsed}` : `${elapsed} · In the background, not in your chat`}</span></>}
      {error && !failure && <span className="avatar-draw-error" role="alert">{error}</span>}
      {busy && <span className="avatar-draw-progress" aria-hidden="true" />}
    </span>
    <span className="avatar-draw-actions">
      {busy && !ready ? <Pill variant="ghost" disabled={disabled || !options.length} onClick={draw.discard}>Stop</Pill> : <>
        <Pill variant="ghost" disabled={disabled || using} onClick={draw.discard}>Discard</Pill>
        {drawing.description && <Pill variant="soft" disabled={disabled || using} onClick={draw.retry}>Try again</Pill>}
        {ready && <Pill disabled={disabled || using} onClick={() => void use(ready)}>Use</Pill>}
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

export function AvatarEditor({ value, onChange, disabled = false, onPendingChange, shared, draw, actions }: { value: AvatarDraft; onChange: (value: AvatarDraft) => void; disabled?: boolean; onPendingChange?: (pending: boolean) => void; shared?: AvatarDefinition[]; draw?: DrawControls; /** Done and close, at the end of the header row on desktop. */ actions?: ReactNode }) {
  const [tab, setTab] = useState<"bot" | "upload">("bot");
  const [crop, setCrop] = useState<Crop | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // A drawn option shows here before Use, like any other choice; closing without Use keeps the saved one.
  const [drawn, setDrawn] = useState<AvatarDefinition | null>(null);
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
  // One surface: the preview on the left (on top on mobile), the header row and the choices beside it.
  return <div className="avatar-editor" onPaste={e => { const file = Array.from(e.clipboardData.files).find(f => f.type.startsWith("image/")); if (file) { e.preventDefault(); void load(file); } }}>
    <div className="avatar-editor-head">
      {tabs}
      <span className="avatar-desktop avatar-editor-actions"><button type="button" className="avatar-editor-reset" disabled={disabled} onClick={reset}>Reset</button>{actions}</span>
    </div>
    <div className="avatar-editor-preview" aria-label="Avatar preview">{drawn ? <Avatar shape={objectShape(drawn.id)} color={value.color} definition={drawn} size={112} /> : <Avatar shape={value.shape} color={value.color} picture={value.avatarImage} definition={value.avatarDefinition} size={112} />}</div>
    <div className="avatar-editor-body">
      {tab === "bot" ? <AvatarPicker labels shape={value.shape} color={value.color} disabled={disabled} shared={shared} draw={draw} onPreview={setDrawn} onChange={(shape, color, definition) => onChange({ shape, color, avatarImage: null, avatarDefinition: definition ?? (shape === value.shape ? value.avatarDefinition : null) })} /> : <div className={clsx("avatar-upload", loading && "opacity-50")} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void load(e.dataTransfer.files[0]); }}>
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
  const done = <Pill disabled={saving || pending} onClick={() => void save()}>Done</Pill>;
  // Mobile keeps the sheet's own header (Back, title, Done); desktop puts Done and close on the editor's header row.
  return <Modal title="Avatar" className="avatar-editor-sheet w-[560px]" onClose={close} onBack={close} headerActions={done}>
    <div className="dialog-body"><AvatarEditor value={draft} onChange={setDraft} disabled={saving} onPendingChange={setPending} shared={shared} draw={draw && { ...draw, use }} actions={<>{done}<IconButton className="avatar-editor-close" onClick={close} aria-label="Close"><X size={16} /></IconButton></>} />{error && <p role="alert" className="avatar-editor-error">{error}</p>}</div>
  </Modal>;
}
