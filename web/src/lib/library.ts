import type { TurnItem } from "./types";
import { workspaceFileKind, workspaceFilePath, workspaceLinkPath, type LibraryResource } from "./workspaceLinks";

export type LibraryEntry =
  | { kind: "link"; id: string; title: string; href: string; detail: string; at: string }
  | { kind: "media" | "file"; id: string; title: string; resource: LibraryResource; detail: string; at: string };

/** `libraryDir` is the Library folder inside the workspace: `library`, or `.bot/library` for a Bot made from a project. */
export type LibraryWorkspace = { workspaceRoot: string; threadId: string | null; libraryDir?: string };
export const libraryDirOf = (workspace: { libraryDir?: string }) => workspace.libraryDir ?? "library";
/** The workspace's Library folder for a Bot. */
export const botLibraryDir = (bot: { adopted?: boolean }) => bot.adopted ? ".bot/library" : "library";

/** Missing or invalid backend timestamps never acquire a fabricated age. */
export function libraryAge(at: string, now = new Date()): string | null {
  const time = Date.parse(at);
  if (!Number.isFinite(time) || time > now.getTime()) return null;
  const days = Math.floor((now.getTime() - time) / 86400000);
  return days ? `${days}d` : `${Math.floor((now.getTime() - time) / 3600000)}h`;
}

export function libraryGroups<T extends LibraryEntry>(entries: T[], now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const week = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7)).getTime();
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    const time = Date.parse(entry.at);
    const label = !Number.isFinite(time) || time > now.getTime() ? "" : time >= today ? "Today" : time >= week ? "This week" : "Older";
    groups.set(label, [...(groups.get(label) ?? []), entry]);
  }
  return ["Today", "This week", "Older", ""].flatMap(label => groups.has(label) ? [{ label, entries: groups.get(label) ?? [] }] : []);
}

export function workspaceLibraryEntry(path: string, workspace: LibraryWorkspace, at = ""): LibraryEntry | null {
  const validated = workspaceFilePath(path);
  if (!validated || !workspace.threadId) return null;
  const kind = workspaceFileKind(validated);
  return { kind: kind === "image" || kind === "video" ? "media" : "file", id: `workspace:${validated}`, title: validated.startsWith(`${libraryDirOf(workspace)}/`) ? validated.slice(libraryDirOf(workspace).length + 1) : validated, resource: { _tag: "workspace-file", threadId: workspace.threadId, path: validated }, detail: kind === "image" ? "Image" : kind === "video" ? "Video" : "Workspace file", at };
}

export function conversationLibrary(items: TurnItem[], workspace?: LibraryWorkspace): LibraryEntry[] {
  const entries = new Map<string, LibraryEntry>();
  for (const item of items) {
    if (item.type !== "user_message" && item.type !== "assistant_message") continue;
    const at = item.startedAt ?? item.updatedAt;
    if (typeof item.text === "string") {
      if (workspace) {
        // Inline Markdown destinations and reference definitions, including file: URLs.
        for (const match of item.text.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|((?:[^\s()]|\([^\s()]*\))+))(?:\s+["'][^\n]*?["'])?\s*\)|^\s*\[[^\]\n]+\]:\s*<?([^\s>]+)>?/gm)) {
          const path = workspaceLinkPath(match[1] ?? match[2] ?? match[3], workspace.workspaceRoot);
          const entry = path ? workspaceLibraryEntry(path, workspace, at) : null;
          if (entry) entries.set(entry.id, entry);
        }
      }
      for (const match of item.text.matchAll(/https?:\/\/[^\s<>"`\]\)*]+/g)) {
        const href = match[0].replace(/[),.;!?]+$/, "");
        try {
          const url = new URL(href);
          entries.set(href, { kind: "link", id: href, href, title: `${url.host}${url.pathname === "/" ? "" : url.pathname}`, detail: url.host, at });
        } catch { /* Only valid web links belong in the Library. */ }
      }
    }
    const attachments: unknown = item.attachments;
    if (!Array.isArray(attachments)) continue;
    for (const value of attachments) {
      if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") continue;
      const name = "name" in value && typeof value.name === "string" ? value.name : "Attachment";
      const mime = "mimeType" in value && typeof value.mimeType === "string" ? value.mimeType : "";
      const media = mime.startsWith("image/") || mime.startsWith("video/") || ("type" in value && value.type === "image");
      entries.set(`attachment:${value.id}`, { kind: media ? "media" : "file", id: `attachment:${value.id}`, title: name, detail: media ? mime.startsWith("video/") ? "Video" : "Image" : "File", resource: { _tag: "attachment", attachmentId: value.id }, at });
    }
  }
  return [...entries.values()].sort((a, b) => b.at.localeCompare(a.at));
}

/** Merge by canonical resource identity so a Markdown reference and file listing share a row. */
export function mergeLibraryEntries(conversation: LibraryEntry[], workspace: LibraryEntry[]): LibraryEntry[] {
  return [...new Map([...workspace, ...conversation].map((entry) => [entry.id, entry])).values()].sort((a, b) => b.at.localeCompare(a.at));
}

export function filterLibraryEntries(entries: LibraryEntry[], filter: string): LibraryEntry[] {
  return entries.filter((entry) => {
    const page = entry.kind === "file" && /\.html?$/i.test(entry.title);
    return filter === "All" || (filter === "Pages" ? page : filter === "Links" ? entry.kind === "link" : filter === "Media" ? entry.kind === "media" : entry.kind === "file" && !page);
  });
}

export function workspaceListingEntries(result: unknown, workspace: LibraryWorkspace): LibraryEntry[] {
  if (!result || typeof result !== "object" || !("entries" in result) || !Array.isArray(result.entries)) throw new Error("Couldn't load workspace files.");
  const entries: LibraryEntry[] = [];
  for (const value of result.entries) {
    if (!value || typeof value !== "object" || !("path" in value) || typeof value.path !== "string" || !("kind" in value) || typeof value.kind !== "string") throw new Error("Couldn't load workspace files.");
    if (value.kind !== "file") continue;
    // The listing API returns workspace-relative paths, not host filesystem paths.
    if (value.path.startsWith("/") || !value.path.startsWith(`${libraryDirOf(workspace)}/`)) throw new Error("Couldn't load workspace files.");
    const entry = workspaceLibraryEntry(value.path, workspace);
    if (!entry) throw new Error("Couldn't load workspace files.");
    entries.push(entry);
  }
  return entries;
}
