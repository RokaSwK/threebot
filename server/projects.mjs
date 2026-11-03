// The Projects board: one live document the user and every Bot edit together.
// Items are projects, to-dos, machines, services, repos, notes and links. Each has a short
// id, so it can be linked from chat (/?item=<id>) and passed between Bots. Every change is
// stamped with who made it and broadcast to open pages, so a Bot's edit shows up at once.
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export const KINDS = ["project", "task", "machine", "service", "repo", "note", "link"];
export const STATUSES = {
  project: ["active", "paused", "idea", "done"],
  task: ["todo", "doing", "waiting", "done"],
  machine: ["online", "offline", "unknown"],
  service: ["running", "stopped", "failing", "unknown"],
  repo: ["active", "archived"],
  note: [],
  link: [],
};
export const PRIORITIES = ["high", "normal", "low"];
export const LINK_TYPES = ["thread", "bot", "item", "url", "t3project"];

const MAX_ITEMS = 5000;
const MAX_BATCH = 100;
const MAX_ACTIVITY = 300;
const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const ID_PATTERN = /^[a-z0-9]{4,24}$/;
const REF_PATTERN = /^ref:([\w-]{1,40})$/;

const invalid = (message) => Object.assign(new Error(message), { status: 400, expose: true });

function newId(taken) {
  for (;;) {
    const bytes = randomBytes(8);
    const id = Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
    if (!taken.has(id)) return id;
  }
}

const text = (value, field, max) => {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw invalid(`${field} must be text.`);
  const trimmed = value.replace(/\r\n/g, "\n").trim();
  if (trimmed.length > max) throw invalid(`${field} is longer than ${max} characters.`);
  return trimmed || undefined;
};
const oneLine = (value, field, max) => {
  const v = text(value, field, max);
  return v === undefined ? undefined : v.replace(/\s+/g, " ");
};

function cleanUrl(value, field = "url") {
  const v = oneLine(value, field, 2000);
  if (v === undefined) return undefined;
  let url;
  try { url = new URL(v); } catch { throw invalid(`${field} must be a full address, like https://example.com.`); }
  if (!["http:", "https:"].includes(url.protocol)) throw invalid(`${field} must start with http:// or https://.`);
  return url.href;
}

function cleanDate(value) {
  const v = oneLine(value, "due", 10);
  if (v === undefined) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw invalid("due must be a date like 2026-11-03.");
  return v;
}

function cleanTags(value) {
  if (value === null || value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalid("tags must be a list of words.");
  const tags = [...new Set(value.map((t) => oneLine(t, "tag", 32)?.toLowerCase()).filter(Boolean))];
  if (tags.length > 12) throw invalid("Use at most 12 tags.");
  return tags.length ? tags : undefined;
}

/** Known extra fields per item. Anything else is refused, so the board stays legible. */
const FIELD_CLEANERS = {
  url: (v) => cleanUrl(v),
  path: (v) => oneLine(v, "path", 500),
  host: (v) => oneLine(v, "host", 200),
  port: (v) => {
    if (v === null || v === undefined || v === "") return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw invalid("port must be a number from 1 to 65535.");
    return n;
  },
  branch: (v) => oneLine(v, "branch", 200),
  due: cleanDate,
  priority: (v) => {
    if (v === null || v === undefined || v === "") return undefined;
    if (!PRIORITIES.includes(v)) throw invalid(`priority must be one of ${PRIORITIES.join(", ")}.`);
    return v;
  },
  owner: (v) => oneLine(v, "owner", 60),
  tags: cleanTags,
};
export const FIELD_NAMES = Object.keys(FIELD_CLEANERS);

function cleanFields(input, previous = {}) {
  if (input === undefined) return previous;
  if (input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw invalid("fields must be an object.");
  const next = { ...previous };
  for (const [key, value] of Object.entries(input)) {
    const cleaner = FIELD_CLEANERS[key];
    if (!cleaner) throw invalid(`Unknown field "${key}". Use ${FIELD_NAMES.join(", ")}, or put it in body.`);
    const cleaned = cleaner(value);
    if (cleaned === undefined) delete next[key];
    else next[key] = cleaned;
  }
  return next;
}

function cleanLink(link) {
  if (!link || typeof link !== "object") throw invalid("Each link must be an object with a type.");
  const label = oneLine(link.label, "link label", 120);
  const base = label ? { label } : {};
  switch (link.type) {
    case "thread": {
      const threadId = oneLine(link.threadId, "threadId", 1024);
      if (!threadId) throw invalid("A thread link needs threadId.");
      const environmentId = oneLine(link.environmentId, "environmentId", 128);
      if (environmentId && !/^[a-zA-Z0-9_-]{1,128}$/.test(environmentId)) throw invalid("environmentId looks wrong.");
      return { type: "thread", threadId, ...(environmentId ? { environmentId } : {}), ...base };
    }
    case "bot": {
      const slug = oneLine(link.slug, "slug", 63);
      if (!slug || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) throw invalid("A Bot link needs the Bot's slug.");
      return { type: "bot", slug, ...base };
    }
    case "item": {
      const id = oneLine(link.id, "id", 40);
      if (!id) throw invalid("An item link needs id.");
      return { type: "item", id, ...base };
    }
    case "url":
      return { type: "url", url: cleanUrl(link.url, "link url") ?? (() => { throw invalid("A url link needs url."); })(), ...base };
    case "t3project": {
      const projectId = oneLine(link.projectId, "projectId", 200);
      if (!projectId) throw invalid("A t3project link needs projectId.");
      const environmentId = oneLine(link.environmentId, "environmentId", 128);
      return { type: "t3project", projectId, ...(environmentId ? { environmentId } : {}), ...base };
    }
    default:
      throw invalid(`Link type must be one of ${LINK_TYPES.join(", ")}.`);
  }
}

const linkKey = (link) => JSON.stringify([link.type, link.threadId ?? link.slug ?? link.id ?? link.url ?? link.projectId, link.environmentId ?? null]);
function cleanLinks(list) {
  if (!Array.isArray(list)) throw invalid("links must be a list.");
  const seen = new Map();
  for (const link of list.map(cleanLink)) seen.set(linkKey(link), link);
  if (seen.size > 40) throw invalid("Use at most 40 links per item.");
  return [...seen.values()];
}

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** An actor is who made a change: the user in the app, or a Bot through its tools. */
export function actorLabel(actor) {
  if (!actor || actor.type === "user") return "You";
  return actor.name || actor.slug || "A Bot";
}

export function createProjects({ file, now = () => new Date().toISOString() }) {
  let state = null;
  let writing = Promise.resolve();
  const listeners = new Set();

  async function load() {
    if (state) return state;
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8"));
      state = { version: Number(raw.version) || 0, seq: Number(raw.seq) || 0, items: raw.items && typeof raw.items === "object" ? raw.items : {}, activity: Array.isArray(raw.activity) ? raw.activity : [] };
    } catch (error) {
      if (error.code !== "ENOENT") throw Object.assign(new Error("The Projects board file can't be read."), { cause: error });
      state = { version: 0, seq: 0, items: {}, activity: [] };
    }
    return state;
  }

  async function persist() {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(tmp, file);
  }

  /** Writes run one at a time, so two Bots saving together never lose each other's change. */
  function exclusive(fn) {
    const run = writing.then(fn, fn);
    writing = run.catch(() => {});
    return run;
  }

  function emit(event) {
    for (const listener of listeners) {
      try { listener(event); } catch {}
    }
  }

  function record(entries) {
    state.activity.push(...entries);
    if (state.activity.length > MAX_ACTIVITY) state.activity.splice(0, state.activity.length - MAX_ACTIVITY);
  }

  function resolveRef(value, refs, field) {
    if (value === null) return null;
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw invalid(`${field} must be an item id.`);
    const ref = REF_PATTERN.exec(value);
    const id = ref ? refs.get(ref[1]) : value;
    if (!id) throw invalid(`${field} "${value}" doesn't name an item in this batch.`);
    if (!state.items[id]) throw invalid(`${field} "${value}" isn't on the board.`);
    return id;
  }

  function assertNoCycle(id, parentId) {
    for (let at = parentId, steps = 0; at; at = state.items[at]?.parentId, steps++) {
      if (at === id || steps > 50) throw invalid("An item can't be inside itself.");
    }
  }

  async function snapshot() {
    await load();
    return { version: state.version, items: Object.values(state.items), activity: state.activity.slice(-60) };
  }

  /**
   * Create or change items. An input without id creates one; with id it changes only the
   * given properties (null clears one). `ref` names a new item so others in the same batch
   * can use "ref:<name>" as parentId or machineId.
   */
  function save(inputs, actor) {
    return exclusive(async () => {
      await load();
      if (!Array.isArray(inputs) || inputs.length === 0) throw invalid("Give at least one item.");
      if (inputs.length > MAX_BATCH) throw invalid(`Save at most ${MAX_BATCH} items at a time.`);
      const stamp = now();
      const who = actor?.type === "bot" ? { type: "bot", name: actor.name, slug: actor.slug } : { type: "user" };
      const before = structuredClone(state.items);
      const refs = new Map();
      const taken = new Set(Object.keys(state.items));
      // Give every new item its id first, so items later in the batch can point at earlier ones and back.
      const plan = inputs.map((input, index) => {
        if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid(`Item ${index + 1} must be an object.`);
        if (input.id !== undefined) {
          if (typeof input.id !== "string" || !state.items[input.id]) throw invalid(`There's no item "${input.id}". Leave id out to create one.`);
          return { input, id: input.id, created: false };
        }
        const id = newId(taken);
        taken.add(id);
        if (input.ref !== undefined) {
          if (typeof input.ref !== "string" || !/^[\w-]{1,40}$/.test(input.ref)) throw invalid("ref must be a short name of letters, digits, - or _.");
          if (refs.has(input.ref)) throw invalid(`ref "${input.ref}" is used twice.`);
          refs.set(input.ref, id);
        }
        return { input, id, created: true };
      });
      if (Object.keys(state.items).length + plan.filter((p) => p.created).length > MAX_ITEMS) throw invalid(`The board holds at most ${MAX_ITEMS} items. Archive or delete some first.`);
      try {
        for (const step of plan) if (step.created) state.items[step.id] = { id: step.id, kind: KINDS.includes(step.input.kind) ? step.input.kind : "task", title: "(untitled)", fields: {}, links: [], pinned: false, archived: false, createdAt: stamp, updatedAt: stamp, createdBy: who, updatedBy: who };
        const changed = [];
        const entries = [];
        for (const { input, id, created } of plan) {
          const prev = before[id];
          const item = state.items[id];
          if (created && !KINDS.includes(input.kind)) throw invalid(`kind must be one of ${KINDS.join(", ")}.`);
          if (!created && input.kind !== undefined && input.kind !== item.kind) {
            if (!KINDS.includes(input.kind)) throw invalid(`kind must be one of ${KINDS.join(", ")}.`);
            item.kind = input.kind;
          }
          if (created || input.title !== undefined) {
            const title = oneLine(input.title, "title", 200);
            if (!title) throw invalid("Every item needs a title.");
            item.title = title;
          }
          const statuses = STATUSES[item.kind];
          if (input.status !== undefined) {
            if (input.status === null || input.status === "") delete item.status;
            else if (!statuses.includes(input.status)) throw invalid(statuses.length ? `A ${item.kind}'s status is one of ${statuses.join(", ")}.` : `A ${item.kind} has no status.`);
            else item.status = input.status;
          }
          if (item.status && !statuses.includes(item.status)) delete item.status;
          if (!item.status && statuses.length) item.status = statuses[item.kind === "machine" || item.kind === "service" ? statuses.length - 1 : 0];
          if (input.area !== undefined) {
            const area = oneLine(input.area, "area", 40)?.toLowerCase();
            if (area) item.area = area; else delete item.area;
          }
          if (input.body !== undefined) {
            const body = text(input.body, "body", 20000);
            if (body) item.body = body; else delete item.body;
          }
          for (const key of ["parentId", "machineId"]) {
            if (input[key] === undefined) continue;
            const target = resolveRef(input[key], refs, key);
            if (target === id) throw invalid(`An item can't be its own ${key === "parentId" ? "parent" : "machine"}.`);
            if (target && key === "machineId" && state.items[target].kind !== "machine") throw invalid("machineId must point at a machine.");
            if (target) item[key] = target; else delete item[key];
          }
          if (item.parentId) assertNoCycle(id, item.parentId);
          if (input.fields !== undefined) item.fields = cleanFields(input.fields, item.fields);
          if (input.links !== undefined) item.links = input.links === null ? [] : cleanLinks(input.links);
          if (input.addLinks !== undefined) item.links = cleanLinks([...item.links, ...(Array.isArray(input.addLinks) ? input.addLinks : [input.addLinks])]);
          if (input.removeLinks !== undefined) {
            const drop = new Set(cleanLinks(Array.isArray(input.removeLinks) ? input.removeLinks : [input.removeLinks]).map(linkKey));
            item.links = item.links.filter((link) => !drop.has(linkKey(link)));
          }
          for (const link of item.links) if (link.type === "item") link.id = resolveRef(link.id, refs, "link id");
          if (input.pinned !== undefined) item.pinned = Boolean(input.pinned);
          if (input.order !== undefined) {
            if (input.order === null) delete item.order;
            else if (typeof input.order !== "number" || !Number.isFinite(input.order)) throw invalid("order must be a number.");
            else item.order = input.order;
          }
          if (input.archived !== undefined) item.archived = Boolean(input.archived);
          const fieldsChanged = ["kind", "title", "status", "area", "body", "parentId", "machineId", "fields", "links", "pinned", "order", "archived"].filter((key) => created || !sameValue(prev?.[key], item[key]));
          if (!created && fieldsChanged.length === 0) continue;
          if (item.kind === "task" && item.status === "done" && (created || prev?.status !== "done")) item.doneAt = stamp;
          if (item.status !== "done") delete item.doneAt;
          item.updatedAt = stamp;
          item.updatedBy = who;
          changed.push(item);
          const action = created ? "created" : fieldsChanged.includes("archived") ? (item.archived ? "archived" : "restored") : item.kind === "task" && fieldsChanged.includes("status") && item.status === "done" ? "completed" : "updated";
          entries.push({ seq: ++state.seq, at: stamp, actor: who, itemId: id, kind: item.kind, title: item.title, action, changed: created ? [] : fieldsChanged });
        }
        if (changed.length === 0) return { version: state.version, items: [], unchanged: true };
        state.version += 1;
        record(entries);
        await persist();
        const event = { version: state.version, items: structuredClone(changed), removed: [], activity: entries };
        emit(event);
        return { version: state.version, items: event.items };
      } catch (error) {
        state.items = before;
        throw error;
      }
    });
  }

  /** Remove items for good. Their children move up to the removed item's parent. */
  function remove(ids, actor) {
    return exclusive(async () => {
      await load();
      if (!Array.isArray(ids) || ids.length === 0) throw invalid("Give at least one id.");
      const who = actor?.type === "bot" ? { type: "bot", name: actor.name, slug: actor.slug } : { type: "user" };
      const stamp = now();
      const gone = ids.filter((id) => state.items[id]);
      if (gone.length === 0) throw invalid("None of those items are on the board.");
      const goneSet = new Set(gone);
      const moved = [];
      for (const item of Object.values(state.items)) {
        if (goneSet.has(item.id)) continue;
        let changed = false;
        if (item.parentId && goneSet.has(item.parentId)) {
          let parent = state.items[item.parentId].parentId;
          while (parent && goneSet.has(parent)) parent = state.items[parent].parentId;
          if (parent) item.parentId = parent; else delete item.parentId;
          changed = true;
        }
        if (item.machineId && goneSet.has(item.machineId)) { delete item.machineId; changed = true; }
        const links = item.links.filter((link) => !(link.type === "item" && goneSet.has(link.id)));
        if (links.length !== item.links.length) { item.links = links; changed = true; }
        if (changed) { item.updatedAt = stamp; moved.push(item); }
      }
      const entries = gone.map((id) => ({ seq: ++state.seq, at: stamp, actor: who, itemId: id, kind: state.items[id].kind, title: state.items[id].title, action: "deleted", changed: [] }));
      for (const id of gone) delete state.items[id];
      state.version += 1;
      record(entries);
      await persist();
      const event = { version: state.version, items: structuredClone(moved), removed: gone, activity: entries };
      emit(event);
      return { version: state.version, removed: gone };
    });
  }

  async function get(id) {
    await load();
    return state.items[id] ? structuredClone(state.items[id]) : null;
  }

  async function list() {
    await load();
    return structuredClone(Object.values(state.items));
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { snapshot, save, remove, get, list, subscribe, activity: async () => (await load()).activity.slice() };
}

// ---------- queries shared by the Bots' tools ----------

const OPEN_TASK = (item) => item.kind === "task" && item.status !== "done" && !item.archived;
const byOrder = (a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || String(a.createdAt).localeCompare(String(b.createdAt));

export function itemLink(id, appUrl = "") {
  return `${appUrl.replace(/\/$/, "")}/?item=${encodeURIComponent(id)}`;
}

/** A compact view for agents: ids, titles and where things sit, without bodies. */
export function brief(item, appUrl) {
  const out = { id: item.id, kind: item.kind, title: item.title };
  for (const key of ["status", "area", "parentId", "machineId"]) if (item[key]) out[key] = item[key];
  if (Object.keys(item.fields ?? {}).length) out.fields = item.fields;
  if (item.pinned) out.pinned = true;
  if (item.archived) out.archived = true;
  if (item.links?.length) out.links = item.links.length;
  out.link = itemLink(item.id, appUrl);
  return out;
}

export function overview(items, activity, { appUrl = "" } = {}) {
  const live = items.filter((item) => !item.archived);
  const title = (id) => live.find((item) => item.id === id)?.title;
  const projects = live.filter((item) => item.kind === "project").sort(byOrder).map((p) => ({
    ...brief(p, appUrl),
    openTasks: live.filter((item) => OPEN_TASK(item) && item.parentId === p.id).length,
  }));
  const tasks = live.filter(OPEN_TASK).sort((a, b) => PRIORITIES.indexOf(a.fields?.priority ?? "normal") - PRIORITIES.indexOf(b.fields?.priority ?? "normal") || String(a.fields?.due ?? "9999").localeCompare(String(b.fields?.due ?? "9999")) || byOrder(a, b))
    .slice(0, 60).map((t) => ({ ...brief(t, appUrl), ...(t.parentId ? { project: title(t.parentId) } : {}) }));
  const machines = live.filter((item) => item.kind === "machine").sort(byOrder).map((m) => ({
    ...brief(m, appUrl),
    services: live.filter((item) => item.kind === "service" && item.machineId === m.id).map((s) => brief(s, appUrl)),
    repos: live.filter((item) => item.kind === "repo" && item.machineId === m.id).map((r) => brief(r, appUrl)),
  }));
  const unplacedServices = live.filter((item) => item.kind === "service" && !item.machineId).map((s) => brief(s, appUrl));
  return {
    page: `${appUrl.replace(/\/$/, "")}/?page=projects`,
    counts: Object.fromEntries(KINDS.map((kind) => [kind, live.filter((item) => item.kind === kind).length])),
    projects,
    openTasks: tasks,
    machines,
    ...(unplacedServices.length ? { servicesWithoutMachine: unplacedServices } : {}),
    recent: activity.slice(-12).reverse().map((entry) => ({ at: entry.at, who: actorLabel(entry.actor), action: entry.action, id: entry.itemId, title: entry.title })),
  };
}

export function find(items, query = {}, { appUrl = "" } = {}) {
  const search = typeof query.search === "string" ? query.search.trim().toLowerCase() : "";
  const words = search.split(/\s+/).filter(Boolean);
  const matches = items.filter((item) => {
    if (!query.includeArchived && item.archived) return false;
    if (query.kind && item.kind !== query.kind) return false;
    if (query.status && item.status !== query.status) return false;
    if (query.open && item.kind === "task" && item.status === "done") return false;
    if (query.area && item.area !== String(query.area).toLowerCase()) return false;
    if (query.parentId && item.parentId !== query.parentId) return false;
    if (query.machineId && item.machineId !== query.machineId) return false;
    if (query.threadId && !item.links?.some((link) => link.type === "thread" && link.threadId === query.threadId)) return false;
    if (words.length) {
      const hay = [item.title, item.body, item.area, ...(item.fields?.tags ?? []), item.fields?.url, item.fields?.path, item.fields?.host].filter(Boolean).join(" ").toLowerCase();
      if (!words.every((word) => hay.includes(word))) return false;
    }
    return true;
  });
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
  return { total: matches.length, items: matches.sort(byOrder).slice(0, limit).map((item) => brief(item, appUrl)) };
}

export function detail(items, id, { appUrl = "" } = {}) {
  const item = items.find((candidate) => candidate.id === id);
  if (!item) return null;
  const children = items.filter((candidate) => candidate.parentId === id && !candidate.archived).sort(byOrder).map((child) => brief(child, appUrl));
  const onMachine = item.kind === "machine" ? items.filter((candidate) => candidate.machineId === id && !candidate.archived).map((child) => brief(child, appUrl)) : undefined;
  const parent = item.parentId ? items.find((candidate) => candidate.id === item.parentId) : null;
  return {
    ...item,
    link: itemLink(item.id, appUrl),
    ...(parent ? { parent: { id: parent.id, title: parent.title, kind: parent.kind } } : {}),
    children,
    ...(onMachine ? { onThisMachine: onMachine } : {}),
    linkedFrom: items.filter((candidate) => candidate.links?.some((link) => link.type === "item" && link.id === id)).map((candidate) => ({ id: candidate.id, title: candidate.title, kind: candidate.kind })),
  };
}
