// The Projects board as tools on the Bots' own MCP server ("bot"). Every change a Bot makes
// here appears on the user's open Projects page straight away, labelled with the Bot's name.
import { FIELD_NAMES, KINDS, LINK_TYPES, PRIORITIES, STATUSES, detail, find, itemLink, overview, type ProjectStore } from "./projects.mts";

/** An MCP tool definition as listed by tools/list. */
export type ProjectTool = {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
/** The Bot whose main thread is `threadId`; throws when it isn't one. */
export type BotFor = (threadId: unknown) => Promise<{ name?: string; slug?: string }>;
/** A tool call's arguments: the Bot's MCP JSON. Each tool checks what it uses. */
type ToolArgs = Record<string, unknown>;

const threadIdProp = { type: "string", description: "Your main conversation's T3 thread id (in AGENTS.md, or mainThreadId in .bot/bot.json). Changes are shown as made by you." };
const statusHelp = Object.entries(STATUSES).filter(([, list]) => list.length).map(([kind, list]) => `${kind}: ${list.join("|")}`).join("; ");

const linkSchema = {
  type: "object",
  description: `A link. type is one of ${LINK_TYPES.join(", ")}. thread: {threadId, environmentId?} for a T3 thread (environmentId for another machine). bot: {slug}. item: {id} for another board item. url: {url}. t3project: {projectId, environmentId?}. Any link can have a label.`,
  properties: {
    type: { type: "string", enum: LINK_TYPES },
    threadId: { type: "string" },
    environmentId: { type: "string" },
    slug: { type: "string" },
    id: { type: "string" },
    url: { type: "string" },
    projectId: { type: "string" },
    label: { type: "string" },
  },
  required: ["type"],
};

const itemSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Leave out to create an item. Give an existing id to change only the properties you pass." },
    ref: { type: "string", description: "A short name for a new item, so other items in this same call can say parentId or machineId \"ref:<name>\"." },
    kind: { type: "string", enum: KINDS, description: "project, task (a to-do), machine, service (something running somewhere), repo, note or link." },
    title: { type: "string", description: "Short and specific, e.g. \"Ship Threebot projects page\"." },
    status: { type: "string", description: `Depends on kind. ${statusHelp}. Note and link have none.` },
    area: { type: "string", description: "Which part of life it belongs to, e.g. work or personal. Reuse the areas already on the board." },
    parentId: { type: ["string", "null"], description: "The project (or other item) this belongs to. null takes it out." },
    machineId: { type: ["string", "null"], description: "For services and repos: the machine item it runs or lives on." },
    body: { type: "string", description: "Markdown notes: context, decisions, next steps, commands. Replaces the old body; read it first with projects_get." },
    fields: {
      type: "object",
      description: `Extra facts, merged into the existing ones (null removes one): ${FIELD_NAMES.join(", ")}. due is YYYY-MM-DD, priority is ${PRIORITIES.join("|")}, port is a number, tags is a list.`,
      properties: Object.fromEntries(FIELD_NAMES.map((name) => [name, {}])),
    },
    addLinks: { type: "array", items: linkSchema, description: "Links to add: threads working on it, Bots that own it, related items, web pages." },
    removeLinks: { type: "array", items: linkSchema, description: "Links to take off (match on type and target)." },
    links: { type: "array", items: linkSchema, description: "Replace all links. Prefer addLinks/removeLinks." },
    pinned: { type: "boolean", description: "Pinned items sit at the top of the page." },
    order: { type: ["number", "null"], description: "Sort position among siblings; lower comes first." },
    archived: { type: "boolean", description: "true hides it from the page without deleting it; false brings it back." },
  },
};

export const PROJECT_TOOLS: ProjectTool[] = [
  {
    name: "projects_overview",
    title: "Read the Projects board",
    description:
      "The user's Projects page at a glance: every project with its open to-do count, open to-dos (highest priority and soonest first), machines with what runs on each, and the latest changes. Start here when the user asks what's on their plate, what's running where, or before adding things, so you don't duplicate.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: "projects_find",
    title: "Find board items",
    description: "Search the Projects board. Filter by kind, status, area, parent project, machine or a linked thread, or search words in titles, notes, tags, paths and addresses.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "string" },
        kind: { type: "string", enum: KINDS },
        status: { type: "string" },
        open: { type: "boolean", description: "Only to-dos that aren't done." },
        area: { type: "string" },
        parentId: { type: "string" },
        machineId: { type: "string" },
        threadId: { type: "string", description: "Items linked to this T3 thread." },
        includeArchived: { type: "boolean" },
        limit: { type: "number" },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "projects_get",
    title: "Open a board item",
    description: "One item in full: notes, fields, links, what's inside it, what's on it (for a machine) and what links to it, plus its link to share in chat.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "projects_save",
    title: "Add or change board items",
    description:
      "Create items or change existing ones on the Projects board, up to 100 at once. The user sees each change on their screen immediately. Leave id out to create; pass id to change only what you give. To create a project with its to-dos in one call, give the project ref \"x\" and the to-dos parentId \"ref:x\". Mark a to-do done with status \"done\" when the work is finished. Returns the saved items with their links.",
    inputSchema: {
      type: "object",
      properties: { items: { type: "array", items: itemSchema, minItems: 1, maxItems: 100 }, threadId: threadIdProp },
      required: ["items", "threadId"],
    },
  },
  {
    name: "projects_delete",
    title: "Delete board items",
    description: "Delete items for good. Things inside them move up to the deleted item's parent. Prefer archived: true with projects_save unless the user wants it gone or you made a mistake.",
    inputSchema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" }, minItems: 1 }, threadId: threadIdProp },
      required: ["ids", "threadId"],
    },
    annotations: { destructiveHint: true },
  },
];

export const PROJECT_TOOL_NAMES = new Set(PROJECT_TOOLS.map((tool) => tool.name));

const toolJson = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const toolError = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export function createProjectTools({ projects, botFor: defaultBotFor = null, appUrl = "", log = () => {} }: { projects: ProjectStore; botFor?: BotFor | null; appUrl?: string | (() => string); log?: (line: string) => void }) {
  const options = () => ({ appUrl: typeof appUrl === "function" ? appUrl() : appUrl });
  return async function callProjectTool(name: string, args: ToolArgs = {}, context: { botFor?: BotFor | null } = {}): Promise<ToolResult> {
    const botFor = context.botFor ?? defaultBotFor;
    try {
      switch (name) {
        case "projects_overview": {
          const { items, activity } = await projects.snapshot();
          return toolJson(overview(items, activity, options()));
        }
        case "projects_find":
          return toolJson(find(await projects.list(), args, options()));
        case "projects_get": {
          const found = detail(await projects.list(), String(args.id ?? ""), options());
          return found ? toolJson(found) : toolError("No item with that id. Use projects_find.");
        }
        case "projects_save": {
          if (!botFor) return toolError("Saving needs a Bot's threadId.");
          const bot = await botFor(args.threadId);
          const result = await projects.save(args.items, { type: "bot", name: bot.name, slug: bot.slug });
          log(`projects: ${bot.slug} saved ${result.items.length} item(s)`);
          const { appUrl: base } = options();
          return toolJson({ saved: result.items.map((item) => ({ id: item.id, kind: item.kind, title: item.title, ...(item.status ? { status: item.status } : {}), link: itemLink(item.id, base) })), ...(result.unchanged ? { note: "Nothing changed: those values were already set." } : {}) });
        }
        case "projects_delete": {
          if (!botFor) return toolError("Deleting needs a Bot's threadId.");
          const bot = await botFor(args.threadId);
          const result = await projects.remove(args.ids, { type: "bot", name: bot.name, slug: bot.slug });
          log(`projects: ${bot.slug} deleted ${result.removed.length} item(s)`);
          return toolJson({ deleted: result.removed });
        }
        default:
          return toolError(`Unknown tool ${name}`);
      }
    } catch (error) {
      return toolError(String((error as { message?: unknown } | null | undefined)?.message ?? error));
    }
  };
}
