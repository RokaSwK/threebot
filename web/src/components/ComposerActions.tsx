import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { Camera, Folder, Image as ImageIcon, Plus } from "lucide-react";
import { takeAttachmentFiles } from "../lib/chatBehavior";
import { IconButton } from "./ui";

/** One extra line in the composer's menu: a side chat, a fresh session, starting a room over. */
export type ComposerAction = {
  key: string;
  label: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean | "true" | "false" }>;
  onSelect: () => void;
};

/**
 * The composer's `+`: attach files (and, on a phone, take a photo or pick one), plus the screen's
 * own actions. The file inputs stay mounted while the menu closes so a picker's result still
 * arrives; the selection owner is remembered per input, because the same component can serve one
 * composer on each screen.
 *
 * The menu is a real menu: it takes focus on its first item, arrows move between them, Escape
 * closes it and gives the `+` back its focus. Items are out of the Tab order, so Tab leaves the
 * menu for the next control, as a menu is expected to.
 */
export function ComposerActions({ mobile, onFiles, actions = [], triggerRef, resetKey }: {
  mobile: boolean;
  onFiles: (files: File[]) => void;
  actions?: ComposerAction[];
  /** The owner's handle on the `+`, to give it focus back after a flow it started. */
  triggerRef?: RefObject<HTMLButtonElement | null>;
  /** Changes when the composer now belongs to another chat or room; the menu must not follow it. */
  resetKey?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const localTrigger = useRef<HTMLButtonElement>(null);
  const trigger = triggerRef ?? localTrigger;
  const menu = useRef<HTMLDivElement>(null);
  const libraryInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const selectionOwners = useRef(new WeakMap<HTMLInputElement, typeof onFiles>());
  useEffect(() => { setOpen(false); }, [resetKey]);
  const items = () => Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
  const close = (focusTrigger = false) => {
    setOpen(false);
    if (focusTrigger) trigger.current?.focus();
  };
  const choose = (input: HTMLInputElement | null) => {
    if (input) selectionOwners.current.set(input, onFiles);
    close();
    // Stay in this explicit user gesture; never ask for camera access on mount.
    input?.click();
  };
  const selected = (input: HTMLInputElement) => {
    const files = takeAttachmentFiles(input);
    const receive = selectionOwners.current.get(input) ?? onFiles;
    selectionOwners.current.delete(input);
    if (files.length) receive(files);
  };
  useEffect(() => {
    if (!open) return;
    items()[0]?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open]);
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") { setOpen(false); return; }
    if (event.key === "Escape") { event.preventDefault(); close(true); return; }
    const list = items();
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const last = list.length - 1;
    const next = event.key === "ArrowDown" ? (at < 0 ? 0 : (at + 1) % list.length)
      : event.key === "ArrowUp" ? (at < 0 ? last : (at - 1 + list.length) % list.length)
        : event.key === "Home" ? 0
          : event.key === "End" ? last
            : -1;
    if (next < 0) return;
    event.preventDefault();
    list[next]?.focus();
  };
  const pick = (action: ComposerAction) => { close(); action.onSelect(); };
  return (
    <div className="relative shrink-0">
      <IconButton ref={trigger} onClick={() => setOpen((current) => !current)} className="size-9 bg-hover" aria-label="Composer actions" aria-haspopup="menu" aria-expanded={open}>
        <Plus size={18} />
      </IconButton>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => close()} />
          <div
            ref={menu}
            role="menu"
            aria-label="Composer actions"
            onKeyDown={onKeyDown}
            className="chat-attachment-menu pop-in absolute bottom-11 left-0 z-50 w-[200px] max-w-[calc(100vw-3rem)] rounded-xl border border-line bg-elevated p-1 shadow-[var(--shadow-pop)]"
          >
            <button role="menuitem" tabIndex={-1} onClick={() => choose(fileInput.current)} className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] hover:bg-hover">
              <Folder size={14} /> {mobile ? "Choose File" : "Attach files"}
            </button>
            {mobile && <>
              <button role="menuitem" tabIndex={-1} onClick={() => choose(cameraInput.current)} className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] hover:bg-hover">
                <Camera size={14} /> Take Photo
              </button>
              <button role="menuitem" tabIndex={-1} onClick={() => choose(libraryInput.current)} className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] hover:bg-hover">
                <ImageIcon size={14} /> Photo or Video
              </button>
            </>}
            {actions.map((action) => (
              <button key={action.key} role="menuitem" tabIndex={-1} onClick={() => pick(action)} className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] hover:bg-hover">
                <action.icon size={14} aria-hidden="true" /> {action.label}
              </button>
            ))}
          </div>
        </>
      )}
      {/* Keep the inputs mounted while the menu closes so picker results still arrive. */}
      {mobile && <>
        <input ref={libraryInput} aria-label="Photo library" type="file" accept="image/*,video/*" multiple hidden onChange={(e) => selected(e.currentTarget)} />
        <input ref={cameraInput} aria-label="Take photo" type="file" accept="image/*" capture="environment" hidden onChange={(e) => selected(e.currentTarget)} />
      </>}
      <input ref={fileInput} aria-label="Files" type="file" multiple hidden onChange={(e) => selected(e.currentTarget)} />
    </div>
  );
}
