import * as transport from "./t3";

/** Consume Package 1's scoped client when available; never send a remote key locally. */
export function workspaceClient(threadId: string | null) {
  if (threadId && "threadClient" in transport && typeof transport.threadClient === "function") {
    const client: unknown = transport.threadClient(threadId);
    if (!(client instanceof transport.T3Client)) throw new Error("The workspace transport is unavailable.");
    return client;
  }
  if (threadId?.startsWith("environment:")) throw new Error("Remote workspace access needs the environment-scoped transport from Package 1.");
  return transport.t3;
}

export function workspaceEnvironment(threadId: string | null): string | undefined {
  workspaceClient(threadId);
  if (threadId && "threadTarget" in transport && typeof transport.threadTarget === "function") {
    const target: unknown = transport.threadTarget(threadId);
    if (target !== null && typeof target === "object" && "environmentId" in target && typeof target.environmentId === "string") return target.environmentId;
  }
  return undefined;
}
