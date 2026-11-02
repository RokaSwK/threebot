import { workspaceClient } from "./workspaceTransport";
import { isRecord } from "./providerData";
import { workspaceLibraryEntry, type LibraryEntry, type LibraryWorkspace } from "./library";

export function parseFileSearch(value: unknown, workspace: LibraryWorkspace, content: boolean): { entries: LibraryEntry[]; truncated: boolean } {
  if (!isRecord(value) || typeof value.truncated !== "boolean") throw new Error("File search returned an unsupported response.");
  const rows = content ? value.matches : value.entries;
  if (!Array.isArray(rows)) throw new Error("File search returned an unsupported response.");
  const entries = new Map<string, LibraryEntry>();
  for (const row of rows) {
    if (!isRecord(row) || typeof row.path !== "string" || (!content && row.kind !== "file")) continue;
    const entry = workspaceLibraryEntry(row.path, workspace);
    if (!entry) continue;
    entries.set(entry.id, { ...entry, detail: content && typeof row.lineNumber === "number" && typeof row.lineContent === "string" ? `Line ${row.lineNumber}: ${row.lineContent}` : "Workspace file" });
  }
  return { entries: [...entries.values()], truncated: value.truncated };
}
export async function searchLibrary(workspace: LibraryWorkspace, query: string, content: boolean) {
  const common = { cwd: workspace.workspaceRoot, query, limit: 100 };
  const result = await workspaceClient(workspace.threadId).call<unknown>(content ? "projects.searchContents" : "projects.searchEntries", content ? { ...common, caseSensitive: false, wholeWord: false, useRegex: false } : { ...common, kind: "file" });
  return parseFileSearch(result, workspace, content);
}
export function isLibraryPage(entry: LibraryEntry) {
  return entry.kind !== "link" && /\.html?$/i.test(entry.resource._tag === "workspace-file" ? entry.resource.path : entry.title);
}

export function listLibraryFiles(workspace: LibraryWorkspace) {
  return workspaceClient(workspace.threadId).call<unknown>("projects.listEntries", { cwd: workspace.workspaceRoot, directoryPath: "library" });
}
