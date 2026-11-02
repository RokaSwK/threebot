import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { Camera, ChevronRight, ImageIcon } from "lucide-react";
import { Avatar } from "./Avatar";
import { Modal, Pill } from "./ui";
import { avatarShape, botColor, DEFAULT_AVATAR, PICKER_COLORS, PICKER_SHAPES } from "../lib/character";
import "./avatar-editor.css";

export type AvatarDraft = { shape: string; color: string; avatarImage?: string | null };
export const resetAvatar = (): AvatarDraft => ({ ...DEFAULT_AVATAR, avatarImage: null });

export function AvatarPicker({ shape, color, onChange, disabled = false }: { choiceSize?: number; shape: string; color: string; onChange: (shape: string, color: string) => void; disabled?: boolean }) {
  return <fieldset disabled={disabled} className="avatar-picker">
    <legend className="sr-only">Choose an avatar</legend>
    <div className="avatar-shapes">
      {PICKER_SHAPES.map(s => <button type="button" disabled={disabled} key={s} className="avatar-choice" data-shape={s} onClick={() => onChange(s, color)} aria-label={s === "t3" ? "T3 avatar" : `${s} shape`} aria-pressed={avatarShape(shape) === s}>
        <Avatar shape={s} color={color} size={64} />
      </button>)}
    </div>
    <div className="avatar-colors">
      {PICKER_COLORS.map(c => <button key={c.id} type="button" disabled={disabled} onClick={() => onChange(shape, c.id)} style={{ background: botColor(c.id) }} aria-label={c.name} aria-pressed={color === c.id} />)}
    </div>
  </fieldset>;
}

type Crop = { source: HTMLImageElement; zoom: number; x: number; y: number };
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export function AvatarEditor({ value, onChange, disabled = false, onPendingChange }: { value: AvatarDraft; onChange: (value: AvatarDraft) => void; disabled?: boolean; onPendingChange?: (pending: boolean) => void }) {
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
    <div className="avatar-editor-preview" aria-label="Avatar preview"><Avatar shape={value.shape} color={value.color} picture={value.avatarImage} size={112} /></div>
    <div className="avatar-editor-card">
      <div className="avatar-desktop avatar-card-header">{tabs}<button type="button" disabled={disabled} onClick={reset}>Reset</button></div>
      {tab === "bot" ? <AvatarPicker shape={value.shape} color={value.color} disabled={disabled} onChange={(shape, color) => onChange({ shape, color, avatarImage: null })} /> : <div className={clsx("avatar-upload", loading && "opacity-50")} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void load(e.dataTransfer.files[0]); }}>
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
      {tab === "bot" && <button type="button" className="avatar-mobile avatar-reset" disabled={disabled} onClick={reset}>Reset to default</button>}
    </div>
    {error && <p role="alert" className="avatar-editor-error">{error}</p>}
  </div>;
}

export function AvatarEditorDialog({ initial, onSave, onClose }: { initial: AvatarDraft; onSave: (draft: AvatarDraft) => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const changed = draft.shape !== initial.shape || draft.color !== initial.color || (draft.avatarImage ?? null) !== (initial.avatarImage ?? null);
  const close = () => { if (!saving) onClose(); };
  const save = async () => {
    if (saving || pending) return;
    if (!changed) { close(); return; }
    setSaving(true); setError("");
    try { await onSave(draft); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Couldn't save the avatar"); setSaving(false); }
  };
  return <Modal title="Avatar" className="avatar-editor-sheet w-[560px]" onClose={close} onBack={close} headerActions={<Pill disabled={saving || pending} onClick={() => void save()}>Done</Pill>}>
    <div className="dialog-body"><AvatarEditor value={draft} onChange={setDraft} disabled={saving} onPendingChange={setPending} />{error && <p role="alert" className="avatar-editor-error">{error}</p>}</div>
  </Modal>;
}
