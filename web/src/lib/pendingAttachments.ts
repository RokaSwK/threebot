import { useEffect, useMemo, useRef, useState } from "react";
import { toast, uploadAttachment, type Attachment } from "../store";
import { uuid } from "./t3";

export type PendingAttachment = { state: "uploading" | "ready"; attachment: Attachment };
export type ComposerAttachments = ReturnType<typeof usePendingAttachments>;

function release(attachment: Attachment) {
  if (attachment.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(attachment.previewUrl);
}

/**
 * The files a composer has chosen but not sent: upload them to T3, show them while they upload and
 * let the user take one back out. A draft may start with attachments that survived a reload, which
 * are already uploaded and only carry their metadata.
 */
export function usePendingAttachments(initial: Attachment[] = []) {
  const [items, setItems] = useState<PendingAttachment[]>(() => initial.map((attachment) => ({ state: "ready" as const, attachment })));
  const current = useRef(items);
  current.current = items;
  const update = (next: PendingAttachment[]) => { current.current = next; setItems(next); };

  const remove = (id: string) => {
    const item = current.current.find((candidate) => candidate.attachment.id === id);
    if (!item) return;
    update(current.current.filter((candidate) => candidate.attachment.id !== id));
    release(item.attachment);
  };

  const clear = () => {
    for (const item of current.current) release(item.attachment);
    update([]);
  };

  useEffect(() => () => {
    for (const item of current.current) release(item.attachment);
  }, []);

  const addFiles = async (files: FileList | File[]) => {
    const selected = Array.from(files).map((file) => ({ file, attachment: {
      type: file.type.startsWith("image/") ? "image" as const : "file" as const,
      id: uuid(), name: file.name, mimeType: file.type || "application/octet-stream", sizeBytes: file.size,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
    } satisfies Attachment }));
    // Reserve the whole selection before awaiting, so a slow upload cannot be overtaken by a removal.
    update([...current.current, ...selected.map(({ attachment }): PendingAttachment => ({ state: "uploading", attachment }))]);
    for (const { file, attachment } of selected) {
      if (!current.current.some((item) => item.attachment.id === attachment.id)) continue;
      try {
        const uploaded = await uploadAttachment(file);
        if (!current.current.some((item) => item.attachment.id === attachment.id)) { release(uploaded); continue; }
        update(current.current.map((item) => item.attachment.id === attachment.id ? { state: "ready", attachment: uploaded } : item));
        release(attachment);
      } catch {
        const present = current.current.some((item) => item.attachment.id === attachment.id);
        remove(attachment.id);
        if (present) toast(`Couldn't attach ${file.name}`);
      }
    }
  };

  const ready = useMemo(() => items.flatMap((item) => (item.state === "ready" ? [item.attachment] : [])), [items]);
  return { items, ready, busy: items.some((item) => item.state === "uploading"), addFiles, remove, clear };
}
