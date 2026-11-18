// Compresses the static bundle on the way out. The gateway is what Tailscale and the LAN reach
// directly. Cache encoded bytes so concurrent installs can share compression work.
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
export function pickEncoding(acceptEncoding: string | undefined, compressible = true): StaticEncoding | "identity" | "unacceptable" {
  if (!acceptEncoding) return "identity";
  const weights = new Map<string, number>();
  for (const part of acceptEncoding.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name) continue;
    const q = params.length === 0 ? 1 : Number(/^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/.exec(params[0])?.[1] ?? 0);
    weights.set(name.trim(), Math.min(weights.get(name.trim()) ?? 1, q));
  }
  const star = weights.get("*");
  const weight = (coding: string) => weights.get(coding) ?? star ?? 0;
  const brotli = compressible ? weight("br") : 0;
  const gzipped = compressible ? weight("gzip") : 0;
  const identity = weights.get("identity");
  const preferred = Math.max(brotli, gzipped);
  if (preferred > 0 && preferred >= (identity ?? 0)) return brotli >= gzipped ? "br" : "gzip";
  return (identity ?? (star === 0 ? 0 : 1)) > 0 ? "identity" : "unacceptable";
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
