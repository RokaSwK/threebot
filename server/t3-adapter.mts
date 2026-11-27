// Typed boundary over T3Client: isolates T3 Code protocol details and capability detection.
import type { T3Client } from "./t3rpc.mts";

export type T3Capabilities = {
  freshContext: boolean;
  peerLinks: boolean;
  autoSettle: boolean;
  backwardThreadRead: boolean;
};

export type T3Descriptor = {
  version?: string;
  capabilities?: {
    freshContext?: boolean;
    peerLinks?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type T3ThreadSummary = {
  id: string;
  projectId?: string | null;
  title?: string | null;
  modelSelection?: unknown;
  archivedAt?: string | null;
  autoSettleDisabledAt?: string | null;
  updatedAt?: string | null;
  [key: string]: unknown;
};

export type T3ThreadProjection = {
  thread?: T3ThreadSummary | null;
  messages?: Array<{ id: string; scheduledTaskId?: string | null; [key: string]: unknown }> | null;
  runs?: Array<{ id: string; threadId: string; userMessageId: string; requestedAt: string; startedAt?: string | null; status: unknown }> | null;
  attempts?: Array<{ id?: string; runId?: string }> | null;
  providerTurns?: unknown[] | null;
  turnItems?: unknown[] | null;
  [key: string]: unknown;
};

export type T3ShellSnapshot = {
  threads?: T3ThreadSummary[];
  projects?: Array<{ id: string; title?: string; workspaceRoot?: string; archivedAt?: string | null; defaultModelSelection?: unknown; [key: string]: unknown }>;
};

export type T3ScheduledTask = {
  id: string;
  title?: string;
  projectId?: string | null;
  threadId?: string | null;
  lastRunAt?: string | null;
  lastRunStatus?: string | null;
  runCount?: number;
  [key: string]: unknown;
};

export type T3StreamHandle = {
  done: Promise<unknown>;
  cancel: () => void;
};

export function createT3Adapter({
  connect,
  descriptor,
}: {
  connect: () => Promise<T3Client>;
  descriptor: () => Promise<T3Descriptor | null>;
}) {
  let cachedCaps: { at: number; value: T3Capabilities } | null = null;

  async function capabilities(maxAgeMs = 30_000): Promise<T3Capabilities> {
    if (cachedCaps && Date.now() - cachedCaps.at < maxAgeMs) return cachedCaps.value;
    const desc = await descriptor().catch(() => null);
    const caps = desc?.capabilities ?? {};
    const value: T3Capabilities = {
      freshContext: caps.freshContext === true,
      peerLinks: caps.peerLinks === true,
      autoSettle: true,
      backwardThreadRead: true,
    };
    cachedCaps = { at: Date.now(), value };
    return value;
  }

  async function call<T = unknown>(tag: string, payload: object = {}, timeoutMs = 15_000): Promise<T> {
    const client = await Promise.race([
      connect(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("T3 timed out")), 10_000).unref?.()),
    ]);
    return await Promise.race([
      client.call(tag, payload) as Promise<T>,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("T3 timed out")), timeoutMs).unref?.()),
    ]);
  }

  async function dispatch(command: object): Promise<unknown> {
    const client = await connect();
    return client.dispatch(command);
  }

  async function getThreadProjection(threadId: string): Promise<T3ThreadProjection | null> {
    return call<T3ThreadProjection | null>("orchestration.getThreadProjection", { threadId });
  }

  async function getShellSnapshot(archived = false): Promise<T3ShellSnapshot> {
    return (await call<T3ShellSnapshot>(archived ? "orchestration.getArchivedShellSnapshot" : "orchestration.getShellSnapshot", {})) ?? {};
  }

  async function getUsageSummary(params: { sinceDay: string; untilDay: string; timeZone: string; provisional?: boolean }): Promise<{ buckets?: unknown } | null> {
    return call<{ buckets?: unknown } | null>("server.getUsageSummary", params);
  }

  async function listPeerLinks<T = unknown>(): Promise<T[] | null> {
    const caps = await capabilities();
    if (!caps.peerLinks) return null;
    const result = await call<{ links?: T[] }>("peerLinks.list", {}, 45_000);
    return Array.isArray(result?.links) ? result.links : null;
  }

  async function stream(tag: string, payload: object, onItem: (item: unknown) => void): Promise<T3StreamHandle> {
    const client = await connect();
    return client.stream(tag, payload, onItem);
  }

  return {
    capabilities,
    call,
    dispatch,
    getThreadProjection,
    getShellSnapshot,
    getUsageSummary,
    listPeerLinks,
    stream,
  };
}

export type T3Adapter = ReturnType<typeof createT3Adapter>;
