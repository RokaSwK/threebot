import { Children, isValidElement, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components, type ExtraProps, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math-extended";
import { escapePriceDollars } from "../lib/currencyDollars";
import katex from "katex";
import { remarkBotLinks } from "../lib/remarkBotLinks";
import { parseThreadLink } from "../lib/botMessages";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";
import { MermaidDiagram } from "./MermaidDiagram";
import "katex/dist/katex.min.css";
import "./MermaidDiagram.css";

export type RichMarkdownProps = {
  children: string;
  bots?: { slug: string; name: string }[];
  components?: Omit<Components, "pre" | "code">;
  urlTransform?: Options["urlTransform"];
};

function literalCode(node: ExtraProps["node"]) {
  return node?.children.map((child) => child.type === "text" ? child.value : "").join("") ?? "";
}

function MathMarkup({ source, display }: { source: string; display: boolean }) {
  const html = useMemo(() => source.length <= 20000 ? katex.renderToString(source, {
    displayMode: display, output: "htmlAndMathml", trust: false, throwOnError: false,
    strict: "ignore", maxExpand: 1000, maxSize: 20,
  }) : null, [source, display]);
  if (html === null) return <code className="rich-math-literal">{source}</code>;
  return <span className={display ? "rich-math rich-math-display" : "rich-math"} dangerouslySetInnerHTML={{ __html: html }} />;
}

function RichCode({ node, children, className, ...props }: ComponentPropsWithoutRef<"code"> & ExtraProps) {
  if (className?.split(/\s+/).includes("math-inline")) return <MathMarkup source={literalCode(node)} display={false} />;
  return <code {...props} className={className}>{children}</code>;
}

function RichPre(props: ComponentPropsWithoutRef<"pre"> & ExtraProps) {
  const code = props.node?.children.find((child) => child.type === "element" && child.tagName === "code");
  if (code?.type === "element") {
    const classes = code.properties.className ?? [];
    const source = literalCode(code);
    if (classes.includes("math-display")) return <MathMarkup source={source} display />;
    if (classes.includes("language-mermaid")) return <MermaidDiagram source={source.replace(/\n$/, "")} />;
  }
  return <MarkdownCodeBlock {...props} />;
}

function textOfNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOfNode).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOfNode(node.props.children);
  return "";
}

function RichTable({ children, ...props }: ComponentPropsWithoutRef<"table"> & ExtraProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ col: number; dir: "asc" | "desc" } | null>(null);
  const parts = Children.toArray(children);
  const thead = parts.find((c) => isValidElement(c) && c.type === "thead");
  const tbody = parts.find((c) => isValidElement(c) && c.type === "tbody");
  const bodyRows = isValidElement<{ children?: ReactNode }>(tbody) ? Children.toArray(tbody.props.children) : [];

  if (!isValidElement<{ children?: ReactNode }>(thead) || !isValidElement<{ children?: ReactNode }>(tbody) || bodyRows.length <= 3) {
    return <table {...props}>{children}</table>;
  }

  const headRow = Children.toArray(thead.props.children)[0];
  const headCells = isValidElement<{ children?: ReactNode }>(headRow) ? Children.toArray(headRow.props.children) : [];
  const needle = query.trim().toLowerCase();

  const visibleRows = bodyRows
    .filter((row) => !needle || textOfNode(row).toLowerCase().includes(needle))
    .sort((a, b) => {
      if (!sort) return 0;
      const ca = isValidElement<{ children?: ReactNode }>(a) ? Children.toArray(a.props.children)[sort.col] : null;
      const cb = isValidElement<{ children?: ReactNode }>(b) ? Children.toArray(b.props.children)[sort.col] : null;
      const ta = textOfNode(ca).trim();
      const tb = textOfNode(cb).trim();
      const na = Number(ta.replace(/[$,%]/g, ""));
      const nb = Number(tb.replace(/[$,%]/g, ""));
      const cmp = Number.isFinite(na) && Number.isFinite(nb) && ta !== "" && tb !== "" ? na - nb : ta.localeCompare(tb);
      return sort.dir === "asc" ? cmp : -cmp;
    });

  return (
    <div className="my-2 overflow-hidden rounded-xl border border-line">
      <div className="flex items-center justify-between gap-2 border-b border-line bg-card px-2.5 py-1.5">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter table…"
          aria-label="Filter table rows"
          className="w-44 bg-transparent text-[12px] outline-none placeholder:text-faint"
        />
        <span className="text-[11px] text-muted">{visibleRows.length} / {bodyRows.length}</span>
      </div>
      <div className="overflow-x-auto">
        <table {...props} className="m-0 w-full">
          <thead>
            <tr>
              {headCells.map((cell, idx) => (
                <th key={idx} className="cursor-pointer select-none" onClick={() => setSort((s) => s?.col === idx ? { col: idx, dir: s.dir === "asc" ? "desc" : "asc" } : { col: idx, dir: "asc" })}>
                  {isValidElement<{ children?: ReactNode }>(cell) ? cell.props.children : cell}
                  {sort?.col === idx ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{visibleRows}</tbody>
        </table>
      </div>
    </div>
  );
}

/** Drop-in message renderer. Caller retains workspace/link/image navigation. */
export function RichMarkdown({ children, bots = [], components, urlTransform }: RichMarkdownProps) {
  return <ReactMarkdown
    skipHtml
    remarkPlugins={[remarkGfm, [remarkMath, { backslashDelimiters: true }], [remarkBotLinks, { bots }]]}
    components={{ table: RichTable, ...components, pre: RichPre, code: RichCode }}
    urlTransform={urlTransform ?? ((url) => parseThreadLink(url) || url.startsWith("bot:") ? url : defaultUrlTransform(url))}
  >{escapePriceDollars(children)}</ReactMarkdown>;
}
