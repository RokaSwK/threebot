import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { transformWithOxc, type Plugin, type ResolvedConfig } from "vite";

const PUBLIC_ASSETS = ["favicon-32.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"];
const hash = (source: string | Uint8Array) => createHash("sha256").update(source).digest("hex");
const WORKER = fileURLToPath(new URL("../src/sw.ts", import.meta.url));
const MARKER = "BOT_BUILD_PRECACHE";

/** Embed exact build bytes, including lazy chunks, in the worker that installs them. */
export function pwaPrecache(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "bot-pwa-precache",
    apply: "build",
    enforce: "post",
    configResolved(resolved) { config = resolved; },
    generateBundle: { order: "post", async handler(_options, bundle) {
      if (!config.base.startsWith("/") || config.base.startsWith("//") || /[?#]/.test(config.base)) {
        this.error("PWA base must be an absolute same-origin path.");
      }
      if (!config.publicDir) this.error("PWA build requires its public assets.");
      const base = config.base.endsWith("/") ? config.base : config.base + "/";
      const files = new Map<string, string | Uint8Array>();
      let pageMarker: string | undefined;
      for (const item of Object.values(bundle)) {
        if (item.type === "asset" && item.fileName === "index.html") {
          pageMarker = `<meta name="threebot-shell" content="${hash(item.source)}">`;
          item.source = Buffer.from(item.source).toString().replace("</head>", `${pageMarker}\n</head>`);
        }
        if (item.fileName === "index.html" || item.fileName.startsWith("assets/")) {
          if (!item.fileName.endsWith(".map")) files.set(item.fileName, item.type === "chunk" ? item.code : item.source);
        }
      }
      if (!pageMarker || !Buffer.from(files.get("index.html") ?? "").includes(pageMarker)) this.error("PWA build requires index.html with a head.");
      const shellMarker = pageMarker;
      for (const name of PUBLIC_ASSETS) files.set(name, await readFile(path.join(config.publicDir, name)));
      // The manifest is our own checked-in static file; only URL bases change.
      const manifest: unknown = JSON.parse(await readFile(path.join(config.publicDir, "manifest.webmanifest"), "utf8"));
      if (!manifest || typeof manifest !== "object" || !("icons" in manifest) || !Array.isArray(manifest.icons)) {
        this.error("PWA manifest requires its icon list.");
      }
      Object.assign(manifest, { id: base, start_url: base, scope: base });
      const icons: unknown[] = manifest.icons;
      for (const icon of icons) {
        if (!icon || typeof icon !== "object" || !("src" in icon) || typeof icon.src !== "string") {
          this.error("PWA manifest requires local icon paths.");
        }
        icon.src = base + path.posix.basename(icon.src);
      }
      const manifestSource = JSON.stringify(manifest, null, 2) + "\n";
      files.set("manifest.webmanifest", manifestSource);
      this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source: manifestSource });
      const entries = [...files].map(([name, source]) => ({
        url: base + name.split("/").map(encodeURIComponent).join("/"),
        sha256: hash(source),
        // Edge proxies can inject HTML. Identify the page itself as well as its entry scripts.
        ...(name === "index.html" ? { markers: [shellMarker, ...Array.from(Buffer.from(source).toString().matchAll(/(?:src|href)="([^"]*\/assets\/[^"?]+)"/g), (match) => match[1])] } : {}),
      })).sort((a, b) => a.url.localeCompare(b.url));
      // The worker is a classic script with no imports, so stripping its types is the whole build.
      const { code: template } = await transformWithOxc(await readFile(WORKER, "utf8"), WORKER, { lang: "ts" });
      if (template.split(MARKER).length !== 2) this.error("PWA worker is missing its build manifest marker.");
      const revision = hash(template + JSON.stringify(entries)).slice(0, 24);
      const source = template.replace(MARKER, () => JSON.stringify({ revision, base, entries }));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    } },
  };
}
