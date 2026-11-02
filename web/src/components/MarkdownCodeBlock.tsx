import { Children, cloneElement, isValidElement, useEffect, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type CSSProperties } from "react";
import type { ExtraProps } from "react-markdown";
import { Check, Copy, LoaderCircle } from "lucide-react";
import { copyText } from "../lib/t3";
import { highlightCode, type CodeToken } from "../lib/highlightCode";
import "./MarkdownCodeBlock.css";

type CopyState = "idle" | "copying" | "copied" | "error";
type CodeBlockProps = ComponentPropsWithoutRef<"pre"> & ExtraProps;

function codeDetails(node: ExtraProps["node"]) {
  let language = "";
  let source: string | undefined;
  for (const child of node?.children ?? []) {
    if (child.type !== "element" || child.tagName !== "code") continue;
    source = child.children.map((part) => part.type === "text" ? part.value : "").join("");
    for (const name of child.properties.className ?? []) {
      if (typeof name === "string" && name.startsWith("language-")) {
        language = name.slice("language-".length);
        break;
      }
    }
    break;
  }
  return { language, source, hasCode: source === undefined || source.replace(/\n$/, "").length > 0 };
}

/** ReactMarkdown's pre renderer. Inline code stays with its ordinary renderer. */
export function MarkdownCodeBlock({ children, node, ...props }: CodeBlockProps) {
  const { language, source, hasCode } = codeDetails(node);
  const pre = useRef<HTMLPreElement>(null);
  const content = useRef<{ text: string; language: string } | null>(null);
  const pending = useRef<symbol | null>(null);
  const reset = useRef<number | null>(null);
  const [state, setState] = useState<CopyState>("idle");
  const [highlighted, setHighlighted] = useState<{ source: string; language: string; tokens: CodeToken[] } | null>(null);
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    if (source !== undefined && hasCode) {
      void highlightCode(source, language, controller.signal).then((tokens) => {
        if (current && tokens) setHighlighted({ source, language, tokens });
      }).catch(() => { /* Highlighting must never prevent reading or copying. */ });
    }
    return () => { current = false; controller.abort(); };
  }, [source, language, hasCode]);
  // A replacement renders plain immediately, even before its effect runs.
  const tokens = highlighted && highlighted.source === source && highlighted.language === language ? highlighted.tokens : null;
  const codeChildren = Children.map(children, (child) => {
    if (!tokens || !isValidElement<ComponentPropsWithoutRef<"code">>(child) || child.type !== "code") return child;
    return cloneElement(child, {}, tokens.map((token, index) => {
      const style: CSSProperties & { "--code-light"?: string; "--code-dark"?: string } = {
        "--code-light": token.light, "--code-dark": token.dark,
      };
      return <span key={index} className="code-token" style={style}>{token.text}</span>;
    }));
  });
  const clearReset = () => {
    if (reset.current !== null) window.clearTimeout(reset.current);
    reset.current = null;
  };

  // Compare rendered text rather than React element identity. Streaming content
  // changes invalidate the operation; an unrelated parent render does not.
  useLayoutEffect(() => {
    const text = pre.current?.textContent ?? "";
    if (content.current?.text === text && content.current.language === language) return;
    content.current = { text, language };
    pending.current = null;
    clearReset();
    setState("idle");
  });
  useLayoutEffect(() => () => { pending.current = null; clearReset(); }, []);

  const copy = async () => {
    if (pending.current || !pre.current) return;
    const operation = Symbol();
    pending.current = operation;
    const text = (pre.current.textContent ?? "").replace(/\n$/, "");
    clearReset();
    setState("copying");
    try {
      await copyText(text);
      if (pending.current !== operation) return;
      pending.current = null;
      setState("copied");
      reset.current = window.setTimeout(() => { reset.current = null; setState("idle"); }, 2000);
    } catch {
      if (pending.current !== operation) return;
      pending.current = null;
      setState("error");
    }
  };
  const label = state === "copying" ? "Copying…" : state === "copied" ? "Copied" : "Copy code";
  return (
    <div className="md-code-block" dir="ltr" data-code-language={language} data-copy-state={state}>
      <pre {...props} ref={pre}>{codeChildren}</pre>
      {hasCode && <button type="button" className="code-copy-button" aria-label={label} title={label} aria-disabled={state === "copying"} onClick={copy}>
        {state === "copied" ? <Check size={14} aria-hidden="true" /> : state === "copying" ? <LoaderCircle size={14} aria-hidden="true" className="animate-spin" /> : <Copy size={14} aria-hidden="true" />}
      </button>}
      {state === "error" && <span role="alert" className="code-copy-error">Couldn't copy code. Try again.</span>}
      <span role="status" className="sr-only">{state === "copied" ? "Code copied." : state === "copying" ? "Copying code…" : ""}</span>
    </div>
  );
}
