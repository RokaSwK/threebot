// The bytes of files this device has already shown, so a conversation keeps its pictures when the
// gateway is out of reach.
//
// A signed asset URL cannot be relied on offline: the URL itself comes from an RPC, and the service
// worker deliberately leaves `/t3/` alone. So the file is fetched once, from the same signed URL that
// would have rendered it, kept as a Blob in IndexedDB (available on a plain LAN origin, where caches
// and OPFS are not) and handed back as an object URL.
//
// One request, never two: a kept file renders from its bytes, and a file too big to keep renders from
// the signed URL, which the browser then loads natively as it always did.

import { forgetRecord, readAsset, writeAsset } from "./threadCache";

/** One stored file. `bytes` duplicates the Blob's size so the index can budget without reading it. */
export type StoredAsset = { v: 1; key: string; savedAt: number; bytes: number; mimeType: string; blob: Blob };

/** A picture from a message. Above this, keeping it would cost more than it is worth. */
const IMAGE_LIMIT = 4 * 1024 * 1024;
/** A file the user opened or downloaded on purpose (a PDF, a document). */
const FILE_LIMIT = 8 * 1024 * 1024;
/** Fetches in flight, so two placements of the same picture share one request. */
const pending = new Map<string, Promise<string | null>>();
/** Object URLs are cheap but must be revoked; one per key while the page lives. */
const urls = new Map<string, string>();

/** A stable key for one asset: the attachment id, or where the picture came from. */
export function assetKey(resource: Record<string, unknown>, scope?: string): string | null {
  if (typeof resource._tag !== "string") return null;
  if (typeof resource.attachmentId === "string" && resource.attachmentId) return `attachment:${resource.attachmentId}`;
  if (resource._tag === "tool-output-image" && typeof resource.itemId === "string") return `tool-image:${String(resource.threadId ?? scope ?? "")}:${resource.itemId}:${String(resource.index ?? 0)}`;
  if (resource._tag === "workspace-file" && typeof resource.path === "string") return `workspace:${String(resource.threadId ?? scope ?? "")}:${resource.path}`;
  if (typeof resource.fileName === "string" && typeof resource.itemId === "string") return `file:${String(resource.threadId ?? scope ?? "")}:${resource.itemId}:${resource.fileName}`;
  return null;
}

const stored = (value: unknown): value is StoredAsset => !!value && typeof value === "object" && (value as StoredAsset).v === 1 && (value as StoredAsset).blob instanceof Blob;

/** A URL for a file this device kept, or null when it has none. */
export async function localAssetUrl(key: string): Promise<string | null> {
  const alive = urls.get(key);
  if (alive) return alive;
  const record = await readAsset(key, stored);
  if (!record) return null;
  const url = URL.createObjectURL(record.blob);
  urls.set(key, url);
  return url;
}

/** Reads a response once, keeps it when it fits, and returns an object URL (or null when it does not). */
async function keepResponse(key: string, response: Response, kind: "image" | "file"): Promise<string | null> {
  if (!response.ok) return null;
  const type = response.headers.get("content-type") ?? "";
  const limit = kind === "image" || type.startsWith("image/") ? IMAGE_LIMIT : FILE_LIMIT;
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) return null;
  const blob = await response.blob();
  if (blob.size === 0 || blob.size > limit) return null;
  await writeAsset(key, { v: 1, key, savedAt: Date.now(), bytes: blob.size, mimeType: blob.type || type, blob });
  const url = URL.createObjectURL(blob);
  urls.set(key, url);
  return url;
}

/** Bytes that would not decode are worse than none: the next attempt signs and fetches again. */
export async function dropAsset(key: string): Promise<void> {
  const url = urls.get(key);
  if (url) {
    try { URL.revokeObjectURL(url); } catch { /* not every implementation revokes */ }
    urls.delete(key);
  }
  await forgetRecord(`asset:${key}`).catch(() => {});
}

/**
 * The source to render for one asset: the bytes, kept on the way through, or the copy this device
 * already holds when the gateway cannot sign a URL. One request in the happy path.
 */
export async function assetSource(
  sign: () => Promise<string>,
  key: string | null,
  kind: "image" | "file" = "image",
  knownBytes?: number,
): Promise<string> {
  if (key) {
    const alive = urls.get(key);
    if (alive) return alive;
  }
  const signed = await sign().catch(() => null);
  if (signed) {
    // Only over http(s): a blob or data URL has no bytes worth fetching again.
    if (!key || !/^(https?:)?\//.test(signed)) return signed;
    // A file too big to keep must not be downloaded here and then again by the caller.
    if (knownBytes !== undefined && knownBytes > (kind === "image" ? IMAGE_LIMIT : FILE_LIMIT)) return signed;
    const shared = pending.get(key);
    if (shared) return (await shared) ?? signed;
    const work = (async () => {
      try {
        return await keepResponse(key, await fetch(signed, { credentials: "same-origin" }), kind);
      } catch {
        return null;
      } finally {
        pending.delete(key);
      }
    })();
    pending.set(key, work);
    return (await work) ?? signed;
  }
  const copy = key ? await localAssetUrl(key) : null;
  if (copy) return copy;
  throw new Error("Couldn't load this file");
}

/**
 * Signs a resource for something that will fetch it itself (a document viewer), falling back to the
 * copy this device kept. Nothing is downloaded here: signing a card is not reading it.
 */
export async function signedAsset(sign: () => Promise<string>, key: string | null): Promise<string> {
  try {
    return await sign();
  } catch (error) {
    const copy = key ? await localAssetUrl(key) : null;
    if (copy) return copy;
    throw error;
  }
}

/** Keeps bytes a viewer already read, so the next launch does not need the gateway for them. */
export async function keepFetchedAsset(key: string | null, response: Response): Promise<void> {
  if (!key || !response.ok) return;
  const copy = response.clone();
  void keepResponse(key, copy, "file").catch(() => {});
}

/** A fresh page (or a test) starts with no object URLs: the stored bytes stay, the handles do not. */
export function resetAssetCopies() {
  for (const url of urls.values()) {
    try { URL.revokeObjectURL(url); } catch { /* not every implementation revokes */ }
  }
  urls.clear();
  pending.clear();
}

/** A signed URL or a copy this device kept: both render and download the same way. */
export const isAssetSource = (url: string) => url.startsWith("/t3/") || url.startsWith("blob:");
