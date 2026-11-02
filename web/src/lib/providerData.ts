import type { t3 } from "./t3";
import { workspaceClient } from "./workspaceTransport";

export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function providerRecords(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value.providers)) throw new Error("Provider information is unavailable.");
  return value.providers.filter(isRecord);
}

/** Both initial reads and pushed provider snapshots are decoded by the consumer. */
export function watchProviderData(onData: (value: unknown) => void, onError: (error: unknown) => void, threadId: string | null = null) {
  let client;
  try { client = workspaceClient(threadId); } catch (error) { onError(error); return () => {}; }
  let live = true;
  let revision = 0;
  let stream: ReturnType<typeof t3.stream> | undefined;
  const start = () => {
    stream?.cancel();
    const current = ++revision;
    void client.call<unknown>("server.getConfig").then((value) => { if (live && current === revision) onData(value); }).catch((error: unknown) => { if (live && current === revision) onError(error); });
    stream = client.stream("subscribeServerConfig", {}, (event: unknown) => {
      if (!live || !isRecord(event)) return;
      if (event.type === "snapshot") { revision++; onData(event.config); }
      if (event.type === "providerStatuses") { revision++; onData(event.payload); }
    });
    void stream.done.catch((error: unknown) => { if (live) onError(error); });
  };
  const reconnect = client.onReconnect(start);
  start();
  return () => { live = false; reconnect(); stream?.cancel(); };
}
