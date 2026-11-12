// Phase 0 spike for rooms (docs/designs/rooms-and-mentions-plan.md).
// Proves, against the real T3, what the room engine will rely on:
//   1. a thread can be launched idle in a Bot's project with a chosen model and runtime mode;
//   2. a dispatched message produces a run whose userMessageId is the one we sent;
//   3. the projection exposes the assistant reply for that run;
//   4. Stop's path (thread.stop) is accepted.
// It creates a real thread and spends one cheap model turn. Not shipped in the app.
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { T3Client } from "../server/t3rpc.mts";

const home = process.env.THREEBOT_HOME ?? path.join(process.env.HOME ?? "", "threebot", "home");
const slug = process.argv[2] ?? "tester";
const t3Url = (process.env.T3_URL ?? "http://127.0.0.1:3773").replace(/\/$/, "");
const token = (process.env.T3_TOKEN ?? "").trim();
const TIMEOUT_MS = 60_000;
const POLL_MS = 500;

type Projection = {
  thread?: { runtimeMode?: string; modelSelection?: unknown; status?: string } | null;
  runs?: { id: string; status: string; userMessageId?: string; requestedAt?: string; completedAt?: string | null; ordinal?: number }[] | null;
  turnItems?: { id: string; runId?: string | null; type?: string; status?: string; text?: unknown; completedAt?: string | null }[] | null;
};

const report: Record<string, unknown> = { at: new Date().toISOString(), slug, t3Url };
const log = (line: string) => console.log(`[spike] ${line}`);

if (!token) {
  console.error("[spike] No T3_TOKEN in the environment (use --env-file).");
  process.exit(2);
}

const bot = JSON.parse(await fs.readFile(path.join(home, "bots", slug, ".bot", "bot.json"), "utf8")) as {
  name?: string; projectId?: string; mainThreadId?: string; model?: unknown;
};
report.bot = { name: bot.name, projectId: bot.projectId, mainThreadId: bot.mainThreadId };
if (!bot.projectId || !bot.mainThreadId) {
  console.error("[spike] The Bot has no projectId or mainThreadId; the provisioner has not run for it.");
  process.exit(2);
}

const client = new T3Client({ baseUrl: t3Url, token, clientLabel: "rooms-spike" });
await client.connect();
log(`connected to ${t3Url}`);

const projection = async (threadId: string): Promise<Projection> =>
  (await client.call("orchestration.getThreadProjection", { threadId })) as Projection;

// 1. What the Bot's main thread uses today: the `inherit` resolution reads exactly this.
const main = await projection(bot.mainThreadId);
const inheritMode = main.thread?.runtimeMode ?? null;
const inheritModel = main.thread?.modelSelection ?? bot.model ?? null;
report.inherited = { runtimeMode: inheritMode, modelSelection: inheritModel };
log(`main thread: runtimeMode=${inheritMode ?? "null"} model=${JSON.stringify(inheritModel)?.slice(0, 80) ?? "null"}`);

// 2. Launch an idle room thread in the same project.
const threadId = randomUUID();
const startedAt = Date.now();
await client.call("orchestration.launchThread", {
  commandId: randomUUID(),
  threadId,
  projectId: bot.projectId,
  title: "#rooms-spike",
  modelSelection: inheritModel,
  runtimeMode: inheritMode ?? "auto",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
});
report.threadId = threadId;
report.launchMs = Date.now() - startedAt;
log(`launched thread ${threadId} in ${report.launchMs} ms`);

// 3. Dispatch the message the room engine would send.
const messageId = randomUUID();
const dispatchedAt = Date.now();
await client.dispatch({
  type: "message.dispatch",
  threadId,
  messageId,
  text: "Reply with exactly: SPIKE-OK",
  attachments: [],
  createdBy: "agent",
  creationSource: "server",
  dispatchMode: { type: "start_immediately" },
});
log(`dispatched message ${messageId}`);

// 4. Wait for the run, then for the reply.
let sawRun: { appearedMs: number; userMessageId?: string; id: string; status: string } | null = null;
let reply: { text: string; status: string; completedAt?: string | null; waitedMs: number } | null = null;
let lastStatus = "";
while (Date.now() - dispatchedAt < TIMEOUT_MS) {
  const now = await projection(threadId);
  const runs = now.runs ?? [];
  const run = runs.find((candidate) => candidate.userMessageId === messageId)
    ?? runs.filter((candidate) => (candidate.ordinal ?? 0) > 0).at(-1);
  if (run && !sawRun) {
    sawRun = {
      appearedMs: Date.now() - dispatchedAt,
      userMessageId: run.userMessageId,
      id: run.id,
      status: run.status,
    };
    log(`run ${run.id} appeared in ${sawRun.appearedMs} ms (userMessageId match: ${run.userMessageId === messageId})`);
  }
  if (run && run.status !== lastStatus) {
    lastStatus = run.status;
    log(`run status: ${run.status}`);
  }
  if (run && ["completed", "failed", "cancelled", "interrupted"].includes(run.status)) {
    const items = now.turnItems ?? [];
    const assistant = items
      .filter((item) => item.runId === run.id && (item.type === "assistant_message" || item.type === "assistant") && item.status === "completed")
      .at(-1);
    if (assistant) {
      reply = {
        text: String(assistant.text ?? "").trim(),
        status: run.status,
        completedAt: run.completedAt ?? assistant.completedAt ?? null,
        waitedMs: Date.now() - dispatchedAt,
      };
      break;
    }
    if (run.status !== "completed") break;
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}
report.run = sawRun;
report.reply = reply;
if (reply) log(`reply after ${reply.waitedMs} ms: ${JSON.stringify(reply.text.slice(0, 120))}`);
else log("no assistant reply within the timeout");

// 5. Stop's path: the engine will call this on a running member.
let stopError: string | null = null;
try {
  await client.dispatch({ type: "thread.stop", threadId, stopDelegatedTasks: true });
} catch (err) {
  stopError = (err as Error).message;
}
report.stop = { accepted: stopError === null, error: stopError };
log(`thread.stop ${stopError === null ? "accepted" : `failed: ${stopError}`}`);

report.verdict = {
  userMessageIdExposed: sawRun?.userMessageId === messageId,
  runAppearedWithin30s: (sawRun?.appearedMs ?? Infinity) <= 30_000,
  replyReadable: !!reply,
  stopAccepted: stopError === null,
};
console.log(JSON.stringify(report, null, 2));
client.close();
process.exit(0);
