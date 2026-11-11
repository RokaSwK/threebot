// Offline alerts: when a linked machine stops answering while threads that Bots started are running
// there, tell each of those Bots once, in its main thread, and again when the machine is back.
// What runs where comes from this machine's own records: a Bot that hands work to another machine
// (delegate_task with target.environmentId) keeps it as a task with `remoteChild`, so the list is
// known even after the other machine has gone quiet.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Machine } from "./machines.mts";

export type RemoteThread = { threadId: string; title: string };
export type BotWork = { slug: string; mainThreadId: string; threads: RemoteThread[] };
/** `notified`: the Bots told so far. `done`: everyone was told, so this outage is settled until the machine is back. */
type Outage = { label: string; since: string; misses: number; notified: { slug: string; mainThreadId: string }[] | null; done?: boolean };

const ACTIVE = new Set(["pending", "preparing", "starting", "queued", "running", "waiting"]);
// One quiet look can be a hiccup; two in a row (about two minutes) is an outage.
const MISSES_FOR_OUTAGE = 2;

/** The tasks in a thread's projection that still run on `environmentId`. */
export function remoteThreads(projection: { subagents?: unknown[] } | null | undefined, environmentId: string): RemoteThread[] {
  const out: RemoteThread[] = [];
  for (const value of projection?.subagents ?? []) {
    const agent = value as { status?: string; title?: string | null; remoteChild?: { environmentId?: string; threadId?: string; title?: string; stoppedThere?: boolean } };
    const child = agent?.remoteChild;
    if (!child || child.environmentId !== environmentId || typeof child.threadId !== "string" || child.stoppedThere) continue;
    if (!ACTIVE.has(String(agent.status))) continue;
    out.push({ threadId: child.threadId, title: child.title || agent.title || "Thread" });
  }
  return out;
}

export function offlineMessage(machine: Pick<Machine, "environmentId" | "label" | "status">, threads: RemoteThread[]) {
  const how = machine.status === "asleep" ? "went to sleep" : "went offline";
  const list = threads.map((thread) => `- [${thread.title.replace(/[[\]]/g, "")}](t3-thread://v2/${machine.environmentId}/${thread.threadId})`).join("\n");
  return `From Threebot: ${machine.label} ${how} with ${threads.length === 1 ? "this thread" : "these threads"} running:\n${list}\n\nThey are paused until it's back. If the work is already pushed, you can pick it up on another machine. I'll tell you when ${machine.label} is back.`;
}
export function backMessage(label: string) {
  return `From Threebot: ${label} is back online. The threads that were running there can carry on.`;
}

export function createOutageAlerts({ file, post, now = Date.now, log = () => {} }: {
  file: string;
  /** Posts a message to a Bot's main thread. */
  post: (mainThreadId: string, text: string) => Promise<unknown>;
  now?: () => number; log?: (line: string) => void;
}) {
  let state: Record<string, Outage> | null = null;
  const load = async (): Promise<Record<string, Outage>> => state ??= await readFile(file, "utf8").then((text) => JSON.parse(text) as Record<string, Outage>).catch((): Record<string, Outage> => ({}));
  const save = async () => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(state) + "\n", { mode: 0o600 }); };

  /** One look at the machines. `work` lists the Bots with threads running on a machine. */
  async function observe(machines: Machine[], work: (environmentId: string) => Promise<BotWork[]>) {
    const outages = await load();
    let changed = false;
    const listed = new Set(machines.map((machine) => machine.environmentId));
    for (const id of Object.keys(outages)) if (!listed.has(id)) { delete outages[id]; changed = true; }
    for (const machine of machines) {
      if (machine.local) continue;
      const outage = outages[machine.environmentId];
      if (machine.status === "online") {
        if (!outage) continue;
        delete outages[machine.environmentId];
        changed = true;
        for (const bot of outage.notified ?? []) await post(bot.mainThreadId, backMessage(machine.label)).catch((error) => log(`machines: couldn't tell ${bot.slug} ${machine.label} is back: ${error.message}`));
        if (outage.notified?.length) log(`machines: ${machine.label} is back; told ${outage.notified.map((bot) => bot.slug).join(", ")}`);
        continue;
      }
      // An expired link is the user's to renew, not an outage.
      if (machine.status === "expired") continue;
      const next: Outage = outage ?? { label: machine.label, since: new Date(now()).toISOString(), misses: 0, notified: null };
      next.misses += 1;
      outages[machine.environmentId] = next;
      changed = true;
      if (next.done || next.misses < MISSES_FOR_OUTAGE) continue;
      next.notified ??= [];
      // A Bot that couldn't be read or told yet is tried again on the next look; one already told never is.
      let complete = true;
      let bots: BotWork[] = [];
      try { bots = (await work(machine.environmentId)).filter((bot) => bot.threads.length && !next.notified!.some((told) => told.slug === bot.slug)); }
      catch (error) {
        // Tell the Bots that could be read now; the others are looked at again next time.
        complete = false;
        bots = (((error as { partial?: BotWork[] }).partial) ?? []).filter((bot) => bot.threads.length && !next.notified!.some((told) => told.slug === bot.slug));
        log(`machines: couldn't read which Bots have work on ${machine.label}: ${(error as Error).message}`);
      }
      for (const bot of bots) {
        try {
          await post(bot.mainThreadId, offlineMessage(machine, bot.threads));
          next.notified.push({ slug: bot.slug, mainThreadId: bot.mainThreadId });
          log(`machines: ${machine.label} went offline; told ${bot.slug}`);
        } catch (error) { complete = false; log(`machines: couldn't tell ${bot.slug} that ${machine.label} went offline: ${(error as Error).message}`); }
      }
      next.done = complete;
    }
    if (changed) await save();
  }
  return { observe };
}
