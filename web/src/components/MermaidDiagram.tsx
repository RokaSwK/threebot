import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, Copy, Download, Maximize, LoaderCircle, RotateCcw } from "lucide-react";
import type { MermaidConfig } from "mermaid";
import { copyText } from "../lib/t3";
import { Modal } from "./ui";
import "./MermaidDiagram.css";

type Theme = "light" | "dark";
type DiagramState = { source: string; theme: Theme } & ({ kind: "loading" } | { kind: "ready"; svg: string } | { kind: "error" });
type CopyState = "idle" | "copying" | "copied" | "error";
let queue: Promise<unknown> = Promise.resolve();

// Mermaid has process-wide mutable configuration; serialize initialization and render.
export function renderMermaid(source: string, theme: Theme, id: string, signal?: AbortSignal): Promise<string> {
  const result = queue.then(async () => {
    signal?.throwIfAborted();
    if (!source.trim() || source.length > 20000) throw new Error("Diagram source is empty or too large.");
    const [{ default: mermaid }, { default: purifier }] = await Promise.all([import("mermaid"), import("dompurify")]);
    signal?.throwIfAborted();
    const config = {
      startOnLoad: false, securityLevel: "strict", htmlLabels: false,
      suppressErrorRendering: true, maxTextSize: 20000, maxEdges: 300,
      theme: theme === "dark" ? "dark" : "neutral", themeVariables: { dropShadow: "none" }, look: "classic", layout: "dagre", logLevel: "fatal",
      fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
      secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "suppressErrorRendering", "htmlLabels", "flowchart", "themeCSS", "themeVariables", "theme", "fontFamily", "dompurifyConfig", "look", "layout"],
    } satisfies MermaidConfig;
    mermaid.initialize(config);
    await mermaid.parse(source);
    signal?.throwIfAborted();
    const staging = document.createElement("div");
    staging.inert = true;
    staging.style.cssText = "position:fixed;left:-100000px;top:0;opacity:0;pointer-events:none";
    document.body.append(staging);
    try {
      const { svg } = await mermaid.render(id, source, staging);
      signal?.throwIfAborted();
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
      if (parsed.querySelector("parsererror") || parsed.documentElement.localName !== "svg") throw new Error("Invalid diagram output.");
      // Keep generated SVG styles and fragment markers, but remove external CSS loads.
      const unsafeCss = (css: string) => /\\|@(?:import|font-face|namespace|document|charset)\b|expression\s*\(|(?:behavior|-moz-binding)\s*:/i.test(css)
        || /url\s*\(/i.test(css.replace(/url\(\s*["']?#[\w:.-]+["']?\s*\)/gi, ""));
      for (const element of parsed.querySelectorAll("*")) {
        if (element.localName === "style" && unsafeCss(element.textContent ?? "")) element.remove();
        for (const attribute of [...element.attributes]) {
          if ((attribute.name === "style" || /url\s*\(/i.test(attribute.value)) && unsafeCss(attribute.value)) element.removeAttributeNode(attribute);
        }
      }
      const clean = purifier.sanitize(parsed.documentElement.outerHTML, {
        USE_PROFILES: { svg: true, svgFilters: true }, RETURN_TRUSTED_TYPE: false,
        FORBID_TAGS: ["a", "foreignObject", "script", "iframe", "object", "embed", "image", "use", "feImage", "animate", "animateMotion", "animateTransform", "set"],
        FORBID_ATTR: ["href", "xlink:href", "target", "tabindex"],
      });
      if (!clean.includes("<svg")) throw new Error("Diagram output was unavailable.");
      return clean;
    } finally { staging.remove(); }
  });
  queue = result.catch(() => {});
  return result;
}

export function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId();
  const id = `bot-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [theme, setTheme] = useState<Theme>(() => typeof document !== "undefined" && document.documentElement.classList.contains("dark") ? "dark" : "light");
  const [rendered, setState] = useState<DiagramState>({ kind: "loading", source, theme });
  const state: DiagramState = rendered.source === source && rendered.theme === theme ? rendered : { kind: "loading", source, theme };
  const [sourceVisible, setSourceVisible] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [zoom, setZoom] = useState(1);
  const stage = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);
  const fit = () => {
    const element = stage.current, svg = element?.querySelector("svg");
    if (!element || !svg) return;
    const box = svg.viewBox.baseVal;
    if (!box.width || !box.height) return;
    setZoom(Math.min(1, (element.clientHeight - 32) * box.width / box.height / (element.clientWidth - 32)));
  };
  const download = async () => {
    if (state.kind !== "ready" || exporting) return;
    setExporting(true); setExportError(false);
    let sourceUrl: string | undefined;
    let downloadUrl: string | undefined;
    try {
      const parsed = new DOMParser().parseFromString(state.svg, "image/svg+xml");
      const svg = parsed.documentElement;
      const viewBox = svg.getAttribute("viewBox")?.split(/[ ,]+/).map(Number);
      if (!viewBox || viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2] <= 0 || viewBox[3] <= 0) throw new Error("Invalid diagram size");
      const scale = Math.min(2, 4096 / Math.max(viewBox[2], viewBox[3]));
      const width = Math.ceil(viewBox[2] * scale), height = Math.ceil(viewBox[3] * scale);
      svg.setAttribute("width", String(width)); svg.setAttribute("height", String(height));
      sourceUrl = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], {type:"image/svg+xml"}));
      const image = new Image(); image.src = sourceUrl; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      context.drawImage(image, 0, 0, width, height);
      const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("PNG unavailable")), "image/png"));
      downloadUrl = URL.createObjectURL(png);
      const link = document.createElement("a"); link.href = downloadUrl; link.download = "diagram.png"; link.click();
    } catch { setExportError(true); }
    finally {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
      if (downloadUrl) { const url = downloadUrl; window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
      setExporting(false);
    }
  };
  useEffect(() => { setPreviewOpen(false); setZoom(1); }, [source]);
  const [attempt, setAttempt] = useState(0);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const copyOperation = useRef<symbol | null>(null);
  useEffect(() => {
    const observeTheme = () => setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    const observer = new MutationObserver(observeTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    observeTheme();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading", source, theme });
    const timer = window.setTimeout(() => {
      void renderMermaid(source, theme, id, controller.signal).then((svg) => {
        if (!controller.signal.aborted) setState({ kind: "ready", svg, source, theme });
      }).catch(() => { if (!controller.signal.aborted) setState({ kind: "error", source, theme }); });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [source, theme, id, attempt]);
  useLayoutEffect(() => {
    copyOperation.current = null; setCopyState("idle");
    return () => { copyOperation.current = null; };
  }, [source]);
  useEffect(() => {
    if (copyState !== "copied") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  const copy = async () => {
    if (copyOperation.current) return;
    const operation = Symbol(); copyOperation.current = operation; setCopyState("copying");
    try {
      await copyText(source);
      if (copyOperation.current === operation) { copyOperation.current = null; setCopyState("copied"); }
    } catch { if (copyOperation.current === operation) { copyOperation.current = null; setCopyState("error"); } }
  };
  const copyLabel = copyState === "copied" ? "Copied" : copyState === "copying" ? "Copying…" : "Copy diagram source";
  return <section className="mermaid-card" aria-label="Mermaid diagram" data-diagram-state={state.kind}>
    <div className="mermaid-toolbar">
      <span>Diagram</span>
      <button type="button" aria-pressed={sourceVisible} onClick={() => setSourceVisible(!sourceVisible)}>Source</button>
      <button type="button" aria-label={copyLabel} title={copyLabel} aria-disabled={copyState === "copying"} onClick={copy}>
        {copyState === "copied" ? <Check size={14} aria-hidden="true" /> : copyState === "copying" ? <LoaderCircle size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      </button>
    </div>
    {!sourceVisible && (state.kind === "ready" ? <button type="button" className="mermaid-canvas" aria-label="Open diagram preview" onClick={() => { setZoom(1); setPreviewOpen(true); }}><span role="img" aria-label="Rendered diagram" dangerouslySetInnerHTML={{ __html: state.svg }} /></button>
      : state.kind === "loading" ? <div className="mermaid-status" role="status"><LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> Rendering diagram…</div>
      : <div className="mermaid-status" role="alert">Couldn't render this diagram.<button type="button" onClick={() => setAttempt((value) => value + 1)}><RotateCcw size={13} aria-hidden="true" /> Try again</button></div>)}
    {(sourceVisible || state.kind === "error") && <pre className="mermaid-source"><code>{source}</code></pre>}
    {copyState === "error" && <div className="mermaid-copy-error" role="alert">Couldn't copy source. Try again.</div>}
    <span role="status" className="sr-only">{copyState === "copied" ? "Diagram source copied." : ""}</span>
    {previewOpen && state.kind === "ready" && <Modal title="Diagram" onClose={() => setPreviewOpen(false)} className="mermaid-preview">
      <div className="mermaid-preview-tools">
        <button type="button" aria-label="Zoom out" disabled={zoom <= .5} onClick={() => setZoom((value) => Math.max(.5, value - .25))}>−</button>
        <button type="button" aria-label="Reset zoom" onClick={() => setZoom(1)}><span aria-label="Zoom level">{Math.round(zoom * 100)}%</span></button>
        <button type="button" aria-label="Zoom in" disabled={zoom >= 3} onClick={() => setZoom((value) => Math.min(3, value + .25))}>+</button>
        <button type="button" aria-label="Fit to screen" title="Fit to screen" onClick={fit}><Maximize size={18} /></button>
        <button type="button" aria-label="Download diagram as PNG" title="Download diagram as PNG" disabled={exporting} onClick={() => void download()}><Download size={18} /></button>
      </div>
      {exportError && <p role="alert" className="mermaid-copy-error">Couldn't export diagram</p>}
      <div ref={stage} className="mermaid-preview-stage" tabIndex={0} aria-label="Diagram preview">
        <div className="mermaid-preview-drawing" style={{ width: `${zoom * 100}%` }} role="img" aria-label="Rendered diagram" dangerouslySetInnerHTML={{ __html: state.svg }} />
      </div>
    </Modal>}
  </section>;
}
