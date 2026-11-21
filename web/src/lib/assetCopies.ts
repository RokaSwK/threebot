// The pictures this device has already shown, so a conversation keeps them when the gateway is out
// of reach.
//
// A signed asset URL cannot be relied on offline: the URL itself comes from an RPC, and the service
// worker deliberately leaves `/t3/` alone. So a picture is fetched once, from the same signed URL that
// would have rendered it, kept as a Blob in IndexedDB (available on a plain LAN origin, where caches
// and OPFS are not) and handed back as an object URL. The signed URL itself is never stored.
//
// Only raster pictures are kept, and only to draw them: an object URL runs as this app's origin, so
// anything a browser could execute (HTML, SVG, XML) stays on its signed, sandboxed URL. Documents are
// never kept; opening or downloading an original always signs it afresh.

import { cacheStopped, readAsset, writeAsset } from "./threadCache";

/** One stored picture. `bytes` duplicates the Blob's size so the index can budget without reading it. */
export type StoredAsset = { v: 1; key: string; savedAt: number; bytes: number; mimeType: string; blob: Blob };

/** Above this, keeping a picture would cost more than it is worth. */
const IMAGE_LIMIT = 4 * 1024 * 1024;
/** Formats a browser only ever draws. */
const RASTER = /^image\/(png|jpeg|gif|webp|avif)$/;
/** A picture that does not arrive in this long is left to the browser, which loads it natively. */
const FETCH_PATIENCE_MS = 15_000;
/**
 * Signing is an RPC over T3's socket, which waits for a connection that may never come: offline or
 * slow, the kept copy answers instead.
 */
const SIGN_PATIENCE_MS = 5_000;
export function promptly(sign: () => Promise<string>): Promise<string> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return Promise.reject(new Error("Offline"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Signing timed out")), SIGN_PATIENCE_MS); });
  return Promise.race([sign(), late]).finally(() => clearTimeout(timer));
}
/** A workspace file can change under the same path; attachments and tool images never do. */
const immutable = (key: string) => !key.startsWith("workspace:");
/** Fetches in flight, so two placements of the same picture share one request. */
const pending = new Map<string, Promise<string | null>>();
/** Object URLs are cheap but must be revoked; one per key while the page lives. */
const urls = new Map<string, string>();

function publish(key: string, blob: Blob): string | null {
  // Signed out (in this tab or another) while this was in flight: hand nothing out.
  if (cacheStopped()) return null;
  const previous = urls.get(key);
  if (previous) return previous;
  const url = URL.createObjectURL(blob);
  urls.set(key, url);
  return url;
}

/** A stable key for one asset: the attachment id, or where the picture came from. */
export function assetKey(resource: Record<string, unknown>, scope?: string): string | null {
  if (typeof resource._tag !== "string") return null;
  if (typeof resource.attachmentId === "string" && resource.attachmentId) return `attachment:${resource.attachmentId}`;
  if (resource._tag === "tool-output-image" && typeof resource.itemId === "string") return `tool-image:${String(resource.threadId ?? scope ?? "")}:${resource.itemId}:${String(resource.index ?? 0)}`;
  if (resource._tag === "workspace-file" && typeof resource.path === "string") return `workspace:${String(resource.threadId ?? scope ?? "")}:${resource.path}`;
  return null;
}

const stored = (value: unknown): value is StoredAsset => !!value && typeof value === "object" && (value as StoredAsset).v === 1 && (value as StoredAsset).blob instanceof Blob && RASTER.test((value as StoredAsset).blob.type);

/** A URL for a picture this device kept, or null when it has none. */
export async function localAssetUrl(key: string): Promise<string | null> {
  const alive = urls.get(key);
  if (alive) return alive;
  const record = await readAsset(key, stored);
  return record ? publish(key, record.blob) : null;
}

/** Reads a picture once, within a time and byte budget, and keeps it when it is a raster that fits. */
async function keepPicture(key: string, signed: string, owner: string | undefined): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_PATIENCE_MS);
  try {
    const response = await fetch(signed, { credentials: "same-origin", signal: controller.signal });
    const type = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
    if (!response.ok || !RASTER.test(type) || !response.body) return null;
    if (Number(response.headers.get("content-length") ?? "0") > IMAGE_LIMIT) return null;
    // The gateway may not say how big it is: count while reading and stop at the limit.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > IMAGE_LIMIT) { controller.abort(); return null; }
      chunks.push(value);
    }
    if (size === 0) return null;
    // The Blob carries the checked raster type, so its object URL can only ever draw a picture.
    const blob = new Blob(chunks as BlobPart[], { type });
    await writeAsset(key, { v: 1, key, savedAt: Date.now(), bytes: size, mimeType: type, blob }, owner);
    return publish(key, blob);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Bytes that would not decode are worse than none: the next attempt signs and fetches again. */
export async function dropAsset(key: string): Promise<void> {
  revokeAssetHandles([`asset:${key}`]);
  const { forgetRecords } = await import("./threadCache");
  await forgetRecords([`asset:${key}`]).catch(() => {});
}

/** Forgotten records (a deleted conversation, a sign-out) take their object URLs with them. */
export function revokeAssetHandles(ids: string[]) {
  for (const id of ids) {
    if (!id.startsWith("asset:")) continue;
    const key = id.slice("asset:".length);
    const url = urls.get(key);
    if (!url) continue;
    try { URL.revokeObjectURL(url); } catch { /* not every implementation revokes */ }
    urls.delete(key);
  }
}

/**
 * The source to draw one picture: a copy this device kept, or the signed URL with the bytes kept on
 * the way through. `owner` is the conversation (`view:<thread>`) or room (`room:<id>`) that shows it,
 * so deleting that takes the picture too. One request in the happy path.
 */
export async function assetSource(
  sign: () => Promise<string>,
  key: string | null,
  { knownBytes, owner }: { knownBytes?: number; owner?: string } = {},
): Promise<string> {
  if (key) {
    const alive = urls.get(key);
    if (alive) return alive;
    // A picture already kept is neither signed nor fetched again.
    if (immutable(key)) {
      const copy = await localAssetUrl(key);
      if (copy) return copy;
    }
  }
  const signed = await promptly(sign).catch(() => null);
  if (signed) {
    // Only over http(s): a blob or data URL has no bytes worth fetching again.
    if (!key || !/^(https?:)?\//.test(signed)) return signed;
    // A picture too big to keep must not be downloaded here and then again by the caller.
    if (knownBytes !== undefined && knownBytes > IMAGE_LIMIT) return signed;
    const shared = pending.get(key);
    if (shared) return (await shared) ?? signed;
    const work = keepPicture(key, signed, owner).finally(() => pending.delete(key));
    pending.set(key, work);
    return (await work) ?? signed;
  }
  const copy = key ? await localAssetUrl(key) : null;
  if (copy) return copy;
  throw new Error("Couldn't load this picture");
}

/** A fresh page, a sign-out (or a test) starts with no object URLs: the stored bytes stay, the handles do not. */
export function resetAssetCopies() {
  for (const url of urls.values()) {
    try { URL.revokeObjectURL(url); } catch { /* not every implementation revokes */ }
  }
  urls.clear();
  pending.clear();
}

/** A signed URL or a picture this device kept: both draw the same way. */
export const isAssetSource = (url: string) => url.startsWith("/t3/") || url.startsWith("blob:");
