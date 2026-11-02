// Fetches a website's own icon so the Vault and Connect apps can show real logos.
// The gateway asks the site itself, so no icon service learns which sites you have logins for.
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import sharp from "sharp";

const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MAX_PAGE = 512 * 1024, MAX_ICON = 1024 * 1024, MAX_HOPS = 3, TIMEOUT = 5000;
const FOUND_FOR = 30 * 864e5, MISSING_FOR = 864e5;
const RASTER = /^image\/(png|jpeg|webp|gif|avif)\b/, ICO = /^image\/(x-icon|vnd\.microsoft\.icon)\b/, SVG = /^image\/svg\+xml\b/;

export const normalizeDomain = (value) => {
  const domain = String(value ?? "").trim().toLowerCase().replace(/\.$/, "");
  return DOMAIN.test(domain) ? domain : null;
};

/** Only public addresses: a saved login must never make the gateway probe the local network. */
export function isPublicAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19)));
  }
  if (!net.isIPv6(address)) return false;
  const value = address.toLowerCase();
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicAddress(mapped[1]);
  return !(value === "::" || value === "::1" || /^f[cd]/.test(value) || /^fe[89ab]/.test(value) || /^ff/.test(value) || value.startsWith("64:ff9b") || value.startsWith("::ffff:"));
}

async function readLimited(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel().catch(() => {}); break; }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Candidates from a page's <link> tags, best first. */
export function iconLinks(html, base) {
  const found = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "";
    const href = /\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (!href || !/\bicon\b|apple-touch-icon/.test(rel)) continue;
    const sizes = /\bsizes\s*=\s*["']?(\d+)/i.exec(tag)?.[1];
    const score = /\.svg(\?|$)/i.test(href) ? 512 : sizes ? Number(sizes) : rel.includes("apple-touch-icon") ? 180 : 32;
    try { found.push({ url: new URL(href.replaceAll("&amp;", "&"), base), score }); } catch { /* a broken link is not a logo */ }
  }
  return found.sort((a, b) => b.score - a.score).map((item) => item.url);
}

export function createSiteIcons({ dir, fetcher = fetch, resolve = lookup }) {
  const running = new Map();

  async function fetchPublic(start, limit) {
    let url = new URL(start);
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
      const addresses = await resolve(url.hostname, { all: true }).catch(() => []);
      if (!addresses.length || !addresses.every(({ address }) => isPublicAddress(address))) return null;
      const response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT), headers: { accept: "text/html,image/*;q=0.9,*/*;q=0.5", "user-agent": "Threebot (site icon)" } });
      if (response.status >= 300 && response.status < 400) {
        const next = response.headers.get("location");
        if (!next) return null;
        url = new URL(next, url);
        continue;
      }
      if (!response.ok) return null;
      return { url, type: (response.headers.get("content-type") ?? "").toLowerCase(), bytes: await readLimited(response, limit) };
    }
    return null;
  }

  async function toIcon({ type, bytes }) {
    if (!bytes.length) return null;
    if (ICO.test(type)) return { type: "image/x-icon", bytes };
    if (!RASTER.test(type) && !SVG.test(type)) return null;
    // Re-encoding means nothing from the site reaches the browser, including SVG scripts.
    const png = await sharp(bytes, { limitInputPixels: 16e6 }).resize(96, 96, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer().catch(() => null);
    return png && { type: "image/png", bytes: png };
  }

  async function find(domain) {
    const page = await fetchPublic(`https://${domain}/`, MAX_PAGE).catch(() => null);
    const links = page && /html/.test(page.type) ? iconLinks(page.bytes.toString("utf8"), page.url) : [];
    for (const url of [...links.slice(0, 4), new URL("/favicon.ico", page?.url ?? `https://${domain}/`)]) {
      const icon = await fetchPublic(url, MAX_ICON).then((result) => result && toIcon(result)).catch(() => null);
      if (icon) return icon;
    }
    return null;
  }

  async function load(domain) {
    const key = createHash("sha256").update(domain).digest("hex").slice(0, 32);
    const file = path.join(dir, `${key}.json`);
    const cached = await stat(file).then(async (info) => ({ info, entry: JSON.parse(await readFile(file, "utf8")) })).catch(() => null);
    if (cached && Date.now() - cached.info.mtimeMs < (cached.entry.type ? FOUND_FOR : MISSING_FOR)) {
      return cached.entry.type ? { type: cached.entry.type, bytes: Buffer.from(cached.entry.data, "base64") } : null;
    }
    const icon = await find(domain);
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(icon ? { type: icon.type, data: icon.bytes.toString("base64") } : {}));
    return icon;
  }

  return {
    get(value) {
      const domain = normalizeDomain(value);
      if (!domain) return Promise.resolve(null);
      if (!running.has(domain)) running.set(domain, load(domain).finally(() => running.delete(domain)));
      return running.get(domain);
    },
  };
}
