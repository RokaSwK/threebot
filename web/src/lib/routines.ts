import { t3, uuid } from "./t3";
import { useApp } from "../store";
import type { Bot, ModelSelection, ProjectShell, ScheduledTask, ThreadShell } from "./types";

export type WorkspaceStrategy = { type: "root"; branch?: string } | { type: "existing_worktree"; worktreePath: string; branch?: string } | { type: "worktree"; baseRef: string; branch?: string; startFromOrigin?: boolean };
export type WebhookFilter = { path: string; op: "exists" } | { path: string; op: "equals" | "notEquals" | "startsWith"; value: string } | { path: string; op: "in"; value: string[] };
export type WebhookSchedule = { type: "webhook"; signature: { header: string; encoding: "hex" | "base64"; prefix: string; secret?: string } | null; maxDeliveryAgeMinutes?: number | null; dedupe?: { replayKey?: string; coalesceKey?: string; coalesceWindowSeconds?: number }; filters?: WebhookFilter[] };
export type RoutineSchedule = Exclude<ScheduledTask["schedule"], { type: "webhook" }> | WebhookSchedule;
export type RoutineActor = "user" | "agent" | "system";
export type RoutineCreationSource = "web" | "mobile" | "mcp" | "provider" | "server";
export type RoutineTask = Omit<ScheduledTask, "schedule"> & { schedule: RoutineSchedule; workspaceStrategy: WorkspaceStrategy; modelSelection: ModelSelection; runtimeMode: "approval-required" | "auto-accept-edits" | "full-access" | "auto"; interactionMode: "default" | "plan"; createdBy?: RoutineActor; creationSource?: RoutineCreationSource; lastRunError?: string | null; webhook?: { path: string; url: string | null; hasSecret: boolean } };
export type RoutineInput = Pick<RoutineTask, "title" | "prompt" | "enabled" | "schedule" | "projectId" | "threadId" | "workspaceStrategy" | "modelSelection" | "runtimeMode" | "interactionMode"> & { threadMode?: ThreadMode; id?: string; requireExisting?: boolean; commandId: string; createdBy: RoutineActor; creationSource: RoutineCreationSource };
export type ThreadMode = NonNullable<ScheduledTask["threadMode"]>;
/** The id prefix of a conversation Threebot started for a routine of its own. */
export const ROUTINE_THREAD_PREFIX = "threebot-routine:";
/** Where T3 will run it: the Bot's chat, a conversation of its own, or one it creates on the first (or every) run. */
export type RoutineDestination = "chat" | "own" | "own-pending" | "new-thread";
/** As T3 reads it: servers before thread modes omit it, and their bound tasks continue the conversation. */
export function threadMode(task: Pick<ScheduledTask, "threadId" | "threadMode">): ThreadMode { return task.threadMode ?? (task.threadId === null ? "new_thread" : "continue"); }
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Incomplete routine data; reconnect before editing.");
  return Object.fromEntries(Object.entries(v));
};
const string = (v: unknown): string => { if (typeof v !== "string") throw new Error("Invalid routine field"); return v; };
const nonempty = (v: unknown): string => { const s = string(v).trim(); if (!s) throw new Error("A value is required"); return s; };
function integer(v: unknown, min: number, max = Number.MAX_SAFE_INTEGER) { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new Error(`Enter a whole number from ${min} to ${max}`); return v; }
function optionalString(v: unknown) { return v === undefined ? undefined : string(v); }
function parseWorkspace(v: unknown): WorkspaceStrategy {
  const s = record(v); const branch = optionalString(s.branch);
  if (s.type === "root") return { type: "root", ...(branch === undefined ? {} : { branch }) };
  if (s.type === "existing_worktree") return { type: s.type, worktreePath: nonempty(s.worktreePath), ...(branch === undefined ? {} : { branch }) };
  if (s.type === "worktree") {
    if (s.startFromOrigin !== undefined && typeof s.startFromOrigin !== "boolean") throw new Error("Invalid workspace strategy");
    return { type: s.type, baseRef: nonempty(s.baseRef), ...(branch === undefined ? {} : { branch }), ...(s.startFromOrigin === undefined ? {} : { startFromOrigin: s.startFromOrigin }) };
  }
  throw new Error("Unsupported workspace strategy; use T3 to edit this routine.");
}
export function parseFilters(value: unknown): WebhookFilter[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error("Filters must be a list of at most 16 rules");
  return value.map((v) => {
    const f = record(v); const path = nonempty(f.path); if (!/^(body|headers|query)(\.|$)/.test(path)) throw new Error("Filter paths must start with body, headers or query");
    if (f.op === "exists") return { path, op: f.op };
    if (f.op === "equals" || f.op === "notEquals" || f.op === "startsWith") return { path, op: f.op, value: string(f.value) };
    if (f.op === "in" && Array.isArray(f.value) && f.value.length) return { path, op: f.op, value: f.value.map((x) => { const s = nonempty(x); if (s !== x || s.includes(",")) throw new Error("Filter list values cannot contain commas or surrounding spaces"); return s; }) };
    throw new Error("Unsupported webhook filter");
  });
}
function template(v: unknown) { const s = string(v); const remainder = s.replace(/\{\{\s*(?:(?:body|headers|query)(?:\.[^{}.\s]+)*|request)\s*\}\}/g, ""); if (s === remainder || /\{\{|\}\}/.test(remainder)) throw new Error("Dedupe keys need a {{body.path}}, {{headers.name}}, {{query.name}} or {{request}} template"); return s; }
export function parseSchedule(value: unknown, editing = false): RoutineSchedule {
  const s = record(value);
  if (s.type === "interval") return { type: s.type, everyMs: integer(s.everyMs, editing ? 1 : 60_000) };
  if (s.type === "fixed_time") {
    const timeOfDay = string(s.timeOfDay); if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(timeOfDay)) throw new Error("Choose a valid time");
    if (s.weekdays !== undefined && !Array.isArray(s.weekdays)) throw new Error("Choose valid weekdays");
    return { type: s.type, timeOfDay, ...(Array.isArray(s.weekdays) ? { weekdays: [...new Set(s.weekdays.map((d) => integer(d, 0, 6)))].sort() } : {}) };
  }
  if (s.type === "once") { const runAt = nonempty(s.runAt); if (!/(Z|[+-]\d{2}:\d{2})$/.test(runAt) || Number.isNaN(Date.parse(runAt))) throw new Error("Choose a valid date and time"); return { type: s.type, runAt }; }
  if (s.type !== "webhook") throw new Error("Unsupported routine trigger");
  let signature: WebhookSchedule["signature"] = null;
  if (s.signature != null) { const sig = record(s.signature); if (sig.encoding !== "hex" && sig.encoding !== "base64") throw new Error("Invalid signature encoding"); signature = { header: nonempty(sig.header), encoding: sig.encoding, prefix: string(sig.prefix), ...(sig.secret === undefined ? {} : { secret: nonempty(sig.secret) }) }; }
  let dedupe: WebhookSchedule["dedupe"];
  if (s.dedupe !== undefined) { const d = record(s.dedupe); dedupe = { ...(d.replayKey === undefined ? {} : { replayKey: template(d.replayKey) }), ...(d.coalesceKey === undefined ? {} : { coalesceKey: template(d.coalesceKey) }), ...(d.coalesceWindowSeconds === undefined ? {} : { coalesceWindowSeconds: integer(d.coalesceWindowSeconds, 10, 3600) }) }; }
  return { type: s.type, signature, ...(s.maxDeliveryAgeMinutes === undefined ? {} : { maxDeliveryAgeMinutes: s.maxDeliveryAgeMinutes === null ? null : integer(s.maxDeliveryAgeMinutes, 1, 1440) }), ...(dedupe === undefined ? {} : { dedupe }), ...(s.filters === undefined ? {} : { filters: parseFilters(s.filters) }) };
}
export function parseRoutineTask(value: unknown): RoutineTask {
  const t = record(value); const m = record(t.modelSelection);
  if (typeof t.enabled !== "boolean" || !(t.threadId === null || typeof t.threadId === "string")) throw new Error("Incomplete routine data");
  if (t.runtimeMode !== "approval-required" && t.runtimeMode !== "auto-accept-edits" && t.runtimeMode !== "full-access" && t.runtimeMode !== "auto") throw new Error("Unsupported routine runtime mode");
  if (t.interactionMode !== "default" && t.interactionMode !== "plan") throw new Error("Unsupported routine interaction mode");
  const options = m.options === undefined ? undefined : Array.isArray(m.options) ? m.options.map((v) => { const o = record(v); if (typeof o.value !== "string" && typeof o.value !== "boolean") throw new Error("Invalid model option"); return { id: nonempty(o.id), value: o.value }; }) : (() => { throw new Error("Invalid model options"); })();
  let webhook: RoutineTask["webhook"];
  if (t.webhook !== undefined) { const w = record(t.webhook); if (typeof w.hasSecret !== "boolean" || !(w.url === null || typeof w.url === "string")) throw new Error("Invalid webhook endpoint"); webhook = { path: string(w.path), url: w.url, hasSecret: w.hasSecret }; }
  if (t.threadMode !== undefined && t.threadMode !== "new_thread" && t.threadMode !== "continue" && t.threadMode !== "fresh_session") throw new Error("Unsupported routine destination; use T3 to edit this routine.");
  return { id: nonempty(t.id), title: nonempty(t.title), prompt: nonempty(t.prompt), enabled: t.enabled, schedule: parseSchedule(t.schedule, true), projectId: nonempty(t.projectId), threadId: t.threadId, ...(t.threadMode === undefined ? {} : { threadMode: t.threadMode }), workspaceStrategy: parseWorkspace(t.workspaceStrategy), modelSelection: { instanceId: nonempty(m.instanceId), model: nonempty(m.model), ...(options ? { options } : {}) }, runtimeMode: t.runtimeMode, interactionMode: t.interactionMode, ...(webhook ? { webhook } : {}), nextRunAt: t.nextRunAt == null ? null : string(t.nextRunAt), lastRunAt: t.lastRunAt == null ? null : string(t.lastRunAt), lastRunStatus: t.lastRunStatus == null ? null : string(t.lastRunStatus), lastRunError: t.lastRunError == null ? null : string(t.lastRunError), runCount: integer(t.runCount, 0), ...(typeof t.blockedByPolicy === "string" && t.blockedByPolicy ? { blockedByPolicy: t.blockedByPolicy } : {}), ...(t.createdBy === "user" || t.createdBy === "agent" || t.createdBy === "system" ? { createdBy: t.createdBy } : {}), ...(t.creationSource === "web" || t.creationSource === "mobile" || t.creationSource === "mcp" || t.creationSource === "provider" || t.creationSource === "server" ? { creationSource: t.creationSource } : {}) };
}
export function routineInput({ task, bot, title, prompt, schedule, commandId }: { task?: ScheduledTask; bot: Bot; title: string; prompt: string; schedule: RoutineSchedule; commandId: string }): RoutineInput {
  const existing = task ? parseRoutineTask(task) : null;
  const thread = bot.mainThreadId ? useApp.getState().threads[bot.mainThreadId] : undefined;
  const modelSelection = existing?.modelSelection ?? thread?.modelSelection ?? bot.model;
  if (!modelSelection || !bot.projectId) throw new Error("This Bot needs a project and model before creating a routine.");
  const parsedSchedule = parseSchedule(schedule);
  if (parsedSchedule.type === "webhook" && parsedSchedule.signature && !parsedSchedule.signature.secret && !(existing?.schedule.type === "webhook" && existing.webhook?.hasSecret)) throw new Error("Enter a signing secret for HMAC verification.");
  return { ...(existing ? { id: existing.id, requireExisting: true } : {}), commandId, title: nonempty(title), prompt: nonempty(prompt), enabled: existing?.enabled ?? false, schedule: parsedSchedule, projectId: existing?.projectId ?? bot.projectId, threadId: existing ? existing.threadId : bot.mainThreadId, workspaceStrategy: existing?.workspaceStrategy ?? { type: "root" }, modelSelection, runtimeMode: existing?.runtimeMode ?? "approval-required", interactionMode: existing?.interactionMode ?? "default", createdBy: existing?.createdBy ?? "user", creationSource: existing?.creationSource ?? "web" };
}
export function routineDestination(task: Pick<ScheduledTask, "threadId" | "threadMode">, bot: Pick<Bot, "mainThreadId">): RoutineDestination {
  if (threadMode(task) === "new_thread") return "new-thread";
  if (task.threadId === null) return "own-pending";
  return task.threadId === bot.mainThreadId ? "chat" : "own";
}
function sameModel(left: ModelSelection, right: ModelSelection | null | undefined) {
  if (!right || left.instanceId !== right.instanceId || left.model !== right.model) return false;
  const normalize = (options: ModelSelection["options"]) => (options ?? []).map((o) => `${o.id}:${String(o.value)}`).sort().join("|");
  return normalize(left.options) === normalize(right.options);
}
/** A save that changes one thing and keeps everything else T3 stored, including who created the routine. */
export function routineSaveInput(task: RoutineTask, patch: { modelSelection?: ModelSelection; threadId?: string; threadMode?: ThreadMode; workspaceStrategy?: WorkspaceStrategy } = {}): RoutineInput {
  return { id: task.id, requireExisting: true, commandId: uuid(), title: task.title, prompt: task.prompt, enabled: task.enabled, schedule: task.schedule, projectId: task.projectId, threadId: patch.threadId ?? task.threadId, ...((patch.threadMode ?? task.threadMode) ? { threadMode: patch.threadMode ?? task.threadMode } : {}), workspaceStrategy: patch.workspaceStrategy ?? task.workspaceStrategy, modelSelection: patch.modelSelection ?? task.modelSelection, runtimeMode: task.runtimeMode, interactionMode: task.interactionMode, createdBy: task.createdBy ?? "user", creationSource: task.creationSource ?? "web" };
}
/** The model a Bot's chat runs on, wherever the block shows it. */
export function chatModelFrom(bot: Bot, thread: ThreadShell | undefined, project: ProjectShell | undefined): ModelSelection | null {
  return thread?.modelSelection ?? project?.defaultModelSelection ?? bot.model ?? null;
}
export function chatModelSelection(bot: Bot): ModelSelection | null {
  const state = useApp.getState();
  return chatModelFrom(bot, bot.mainThreadId ? state.threads[bot.mainThreadId] : undefined, bot.projectId ? state.projects[bot.projectId] : undefined);
}
/**
 * Sets the model this routine runs on. T3 models belong to threads, so picking a model for a routine
 * that shares the Bot's chat moves it to a conversation of its own, created with that model; one that
 * already has its own conversation changes that thread's model. A task T3 will start a thread for
 * only needs its stored selection. Returns null when the pick matches the chat and nothing moved.
 */
export async function setRoutineModel(task: ScheduledTask, bot: Bot, selection: ModelSelection): Promise<RoutineTask | null> {
  const existing = parseRoutineTask(task);
  const destination = routineDestination(existing, bot);
  if (destination === "chat") {
    const chatModel = chatModelSelection(bot);
    if (sameModel(selection, chatModel)) return null;
    if (!bot.projectId) throw new Error("This Bot needs a T3 project before a routine can have its own conversation.");
    // Keep what the routine could do yesterday: a bound run uses the chat's modes, not the task's snapshot.
    const chat = bot.mainThreadId ? useApp.getState().threads[bot.mainThreadId] : undefined;
    const runtimeMode = (chat?.runtimeMode as RoutineTask["runtimeMode"] | undefined) ?? existing.runtimeMode;
    const interactionMode = (chat?.interactionMode as RoutineTask["interactionMode"] | undefined) ?? existing.interactionMode;
    // The id marks it as the routine's own conversation, so the chat knows whose runs to report.
    const launched = record(await t3.call<unknown>("orchestration.launchThread", { commandId: uuid(), threadId: `${ROUTINE_THREAD_PREFIX}${uuid()}`, projectId: bot.projectId, title: existing.title, modelSelection: selection, runtimeMode, interactionMode, workspaceStrategy: { type: "root" } }));
    const threadId = nonempty(launched.threadId);
    try {
      return await saveRoutine(routineSaveInput(existing, { threadId, threadMode: threadMode(existing), workspaceStrategy: { type: "root" }, modelSelection: selection }));
    } catch (cause) {
      // The routine stayed in the chat; keep the thread this attempt created out of the way.
      await t3.dispatch({ type: "thread.archive", threadId }).catch(() => {});
      throw cause;
    }
  }
  if (destination === "own") {
    if (!existing.threadId) throw new Error("This routine has no conversation.");
    await t3.dispatch({ type: "thread.model-selection.set", threadId: existing.threadId, modelSelection: selection });
  }
  return saveRoutine(routineSaveInput(existing, { modelSelection: selection }));
}
/** Moves a routine back into the Bot's chat; its old conversation stays in T3. */
export async function moveRoutineToChat(task: ScheduledTask, bot: Bot): Promise<RoutineTask> {
  const existing = parseRoutineTask(task);
  if (routineDestination(existing, bot) !== "own") throw new Error("This routine already runs in the chat.");
  if (!bot.mainThreadId) throw new Error("This Bot has no conversation yet.");
  return saveRoutine(routineSaveInput(existing, { threadId: bot.mainThreadId, threadMode: threadMode(existing), workspaceStrategy: { type: "root" } }));
}
function reconcile(task: RoutineTask) { useApp.setState((s) => ({ tasks: s.tasks.some((t) => t.id === task.id) ? s.tasks.map((t) => t.id === task.id ? task : t) : [...s.tasks, task] })); return task; }
export async function saveRoutine(input: RoutineInput) { const result = record(await t3.call<unknown>("scheduledTasks.upsert", input)); return reconcile(parseRoutineTask(result.task)); }
/** Runs keep posting in the same thread; a fresh session drops the earlier conversation from the model's context. Needs T3's `scheduledTaskThreadModes`. */
export async function changeRoutineFreshSession(task: ScheduledTask, bot: Bot, fresh: boolean) {
  const existing = parseRoutineTask(task);
  if (threadMode(existing) === "new_thread") throw new Error("This routine starts a new conversation each run.");
  return saveRoutine({ ...routineInput({ task: existing, bot, title: existing.title, prompt: existing.prompt, schedule: existing.schedule, commandId: uuid() }), threadMode: fresh ? "fresh_session" : "continue" });
}
export async function changeRoutineEnabled(task: ScheduledTask, enabled: boolean) { const result = record(await t3.call<unknown>("scheduledTasks.setEnabled", { id: task.id, enabled })); return reconcile(parseRoutineTask(result.task)); }
export async function testRoutine(task: ScheduledTask) { if (task.schedule.type === "webhook") throw new Error("Webhook routines run when their sender calls the private URL."); const result = record(await t3.call<unknown>("scheduledTasks.runNow", { id: task.id })); return reconcile(parseRoutineTask(result.task)); }
export async function removeRoutine(task: ScheduledTask) { const result = record(await t3.call<unknown>("scheduledTasks.delete", { id: task.id })); if (result.id !== task.id) throw new Error("The server did not confirm deletion"); useApp.setState((s) => ({ tasks: s.tasks.filter((t) => t.id !== task.id) })); }
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function scheduleText(task: Pick<ScheduledTask, "schedule">, zone = "auto") {
  const s = task.schedule;
  if (s.type === "once") return Number.isNaN(Date.parse(s.runAt)) ? "Once" : `Once, ${new Date(s.runAt).toLocaleString([], { timeZone: displayTimezone(zone), dateStyle: "medium", timeStyle: "short" })}`;
  if (s.type === "interval") { for (const [ms, unit] of [[86400000, "day"], [3600000, "hour"], [60000, "minute"], [1000, "second"]] as const) if (s.everyMs % ms === 0) { const n = s.everyMs / ms; return `Every ${n === 1 ? "" : `${n} `}${unit}${n === 1 ? "" : "s"}`; } return `Every ${s.everyMs} ms`; }
  if (s.type === "fixed_time") { const [h, m] = s.timeOfDay.split(":").map(Number); const time = new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); const days = s.weekdays ?? []; return `${!days.length || days.length === 7 ? "Every day" : days.length === 5 && [1,2,3,4,5].every((d) => days.includes(d)) ? "Weekdays" : days.map((d) => DAYS[d]).join(", ")} at ${time} (server time)`; }
  return "When a webhook is called";
}
export function displayTimezone(value: string) { const zone = value === "auto" || value === "" ? Intl.DateTimeFormat().resolvedOptions().timeZone : value; try { new Intl.DateTimeFormat([], { timeZone: zone }); return zone; } catch { return Intl.DateTimeFormat().resolvedOptions().timeZone; } }
export function routineDate(at: string, zone: string) { return new Date(at).toLocaleString([], { timeZone: displayTimezone(zone), timeZoneName: "short" }); }
export function dispatchStatus(status?: string | null) { return status === "succeeded" ? "Dispatched" : status === "failed" ? "Dispatch failed" : status === "running" ? "Dispatching" : "No dispatch yet"; }
export type RoutineHistoryRow = { id: string; taskId: string; at: string; status: string; trigger: string; threadId: string | null; runId: string | null; source: "execution" | "dispatch" | "delivery" };
export async function routineHistory(id: string, signal: AbortSignal): Promise<{ rows: RoutineHistoryRow[]; observingSince: string; incomplete: boolean; observing: boolean }> {
  const response = await fetch(`/api/routine-history?task=${encodeURIComponent(id)}`, { signal, cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 404 ? "Recorded history is not available on this gateway yet." : "Couldn't read recorded history");
  const r = record(await response.json());
  if (!Array.isArray(r.rows) || typeof r.incomplete !== "boolean") throw new Error("Invalid routine history");
  return { observingSince: string(r.observingSince), incomplete: r.incomplete, observing: r.observing === true, rows: r.rows.map((v) => { const row = record(v); if (row.source !== "execution" && row.source !== "dispatch" && row.source !== "delivery") throw new Error("Invalid history source"); return { id: nonempty(row.id), taskId: nonempty(row.taskId), at: string(row.at), status: string(row.status), trigger: string(row.trigger), threadId: row.threadId === null ? null : string(row.threadId), runId: row.runId === null ? null : string(row.runId), source: row.source }; }) };
}
export async function webhookDeliveries(id: string) {
  const result = record(await t3.call<unknown>("scheduledTasks.listWebhookDeliveries", { id, acceptAnyOutcome: true }));
  if (!Array.isArray(result.deliveries)) throw new Error("Webhook diagnostics unavailable");
  // Deliberately exclude bodies, query strings, headers, rendered prompts and errors.
  return result.deliveries.map((v) => { const d = record(v); return { id: nonempty(d.id), at: string(d.receivedAt), outcome: string(d.outcome), verified: d.signatureVerified === true }; });
}
export async function copyWebhookUrl(task: ScheduledTask) {
  const endpoint = parseRoutineTask(task).webhook;
  if (!endpoint?.url) throw new Error("T3 has not published a reachable webhook URL. Configure its remote endpoint in T3.");
  await navigator.clipboard.writeText(endpoint.url);
}
export async function rotateWebhookToken(task: ScheduledTask) { const result = record(await t3.call<unknown>("scheduledTasks.rotateWebhookToken", { id: task.id })); return reconcile(parseRoutineTask(result.task)); }
