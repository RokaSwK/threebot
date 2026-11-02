import type { Link, Nodes, PhrasingContent, Root, Text } from "mdast";

/** Turn explicit Bot references into links without touching code, existing links, or ordinary prose. */
export function remarkBotLinks(options: { bots: { slug: string; name: string }[] }) {
  const bots = [...options.bots].sort((a, b) => b.name.length - a.name.length);
  const split = (node: Text): PhrasingContent[] => {
    const text = node.value;
    const parts: PhrasingContent[] = [];
    const pattern = /t3-thread:\/\/v[12]\/[^\s<>"`\])*]+|@[\p{L}\p{N}]/gu;
    let offset = 0;
    for (const match of text.matchAll(pattern)) {
      let value = match[0];
      let url = "";
      if (value.startsWith("t3-thread:")) {
        value = value.replace(/[.,;!?]+$/, "");
        url = value;
      } else {
        const bot = bots.find((b) => text.slice(match.index + 1, match.index + 1 + b.name.length).toLocaleLowerCase() === b.name.toLocaleLowerCase() && !/[\p{L}\p{N}_]/u.test(text[match.index + 1 + b.name.length] ?? ""));
        if (!bot || (match.index > 0 && /[\p{L}\p{N}_]/u.test(text[match.index - 1]))) continue;
        value = `@${bot.name}`;
        url = `bot:${encodeURIComponent(bot.slug)}`;
      }
      if (match.index < offset) continue;
      if (match.index > offset) parts.push({ type: "text", value: text.slice(offset, match.index) });
      const link: Link = { type: "link", url, children: [{ type: "text", value }] };
      parts.push(link);
      offset = match.index + value.length;
    }
    if (!parts.length) return [node];
    if (offset < text.length) parts.push({ type: "text", value: text.slice(offset) });
    return parts;
  };
  const visit = (node: Nodes) => {
    switch (node.type) {
      case "code": case "inlineCode": case "link": case "image": return;
      case "paragraph": case "heading": case "emphasis": case "strong": case "delete": case "tableCell":
        node.children = node.children.flatMap((child) => child.type === "text" ? split(child) : [child]);
        break;
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  return (tree: Root) => { visit(tree); };
}
