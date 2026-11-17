// Compresses the static bundle on the way out. The gateway is what Tailscale and the LAN reach
// directly, and nothing in that path compresses: the whole precached shell is 11.4 MB of text on
// the wire. Brotli at quality 5 takes ~30 ms for a 1.4 MB bundle (quality 11 takes ~2 s), so the
// encoded bytes are kept in memory keyed by the file's mtime and size; a rebuild starts a new key.
import { brotliCompress, constants, gzip, type BrotliOptions, type ZlibOptions } from "node:zlib";

export type StaticEncoding = "br" | "gzip";

/** Types that are text. Images, video and woff2 are already compressed. */
const COMPRESSIBLE = new Set([".html", ".js", ".mjs", ".css", ".svg", ".json", ".webmanifest", ".txt", ".map"]);
/** Below this, the header and the encoder's own overhead cost more than they save. */
const MIN_BYTES = 1024;

export function isCompressible(extension: string, size: number): boolean {
  return size >= MIN_BYTES && COMPRESSIBLE.has(extension.toLowerCase());
}

/**
 * Picks the best coding the client accepts, honouring q-values: `br;q=0` is a refusal, not an
 * acceptance, and `*` only covers codings the header does not name. Missing header means identity.
 */
export function pickEncoding(acceptEncoding: string | undefined): StaticEncoding | null {
  if (!acceptEncoding) return null;
  const weights = new Map<string, number>();
  for (const part of acceptEncoding.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    let weight = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(param);
      if (match) weight = Math.min(1, Math.max(0, Number(match[1])));
    }
    weights.set(name.trim(), weight);
  }
  const star = weights.get("*");
  const weight = (coding: string) => weights.get(coding) ?? star ?? 0;
  const brotli = weight("br"), gzipped = weight("gzip");
  if (!Number.isFinite(brotli) || !Number.isFinite(gzipped)) return null;
  if (brotli > 0 && brotli >= gzipped) return "br";
  return gzipped > 0 ? "gzip" : null;
}

export function encodeBody(raw: Buffer, encoding: StaticEncoding): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null, body: Buffer) => (error ? reject(error) : resolve(body));
    if (encoding === "br") {
      const options: BrotliOptions = { params: { [constants.BROTLI_PARAM_QUALITY]: 5, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } };
      brotliCompress(raw, options, done);
    } else {
      const options: ZlibOptions = { level: 6 };
      gzip(raw, options, done);
    }
  });
}

/**
 * Bounded store of encoded bodies. Two requests for the same file share one compression, and the
 * oldest entry is dropped when the budget is spent (the whole bundle encodes to ~4 MB).
 */
export function createCompressionCache(limitBytes = 24 * 1024 * 1024) {
  const entries = new Map<string, Buffer>();
  const pending = new Map<string, Promise<Buffer>>();
  let bytes = 0;
  const evict = () => {
    for (const [key, body] of entries) {
      if (bytes <= limitBytes) break;
      entries.delete(key);
      bytes -= body.length;
    }
  };
  return {
    async get(key: string, load: () => Promise<Buffer>): Promise<Buffer> {
      const hit = entries.get(key);
      if (hit) {
        entries.delete(key); // re-inserting marks it as most recently used
        entries.set(key, hit);
        return hit;
      }
      let next = pending.get(key);
      if (!next) {
        next = load()
          .then((body) => { entries.set(key, body); bytes += body.length; evict(); return body; })
          .finally(() => pending.delete(key));
        pending.set(key, next);
      }
      return next;
    },
    get bytes() { return bytes; },
  };
}
