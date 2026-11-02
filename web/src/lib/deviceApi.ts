import { environmentPrefix, threadClient, threadTarget, type T3Client } from "./t3";

export type DeviceSession = { threadId: string; hostId: string; deviceId: string; platform: "ios" | "android" };
export type DeviceState = {
  revision: number;
  hostStatus: string;
  sessions: DeviceSession[];
  devices: { hostId: string; id: string; name: string }[];
  hosts: { id: string; label: string; kind: string }[];
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid device state");
  return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid device field");
  return value;
}
export function parseDeviceState(value: unknown, threadId: string): DeviceState {
  const state = record(value);
  if (!Array.isArray(state.sessions) || !Array.isArray(state.devices) || !Array.isArray(state.hosts)
    || typeof state.revision !== "number" || !Number.isSafeInteger(state.revision) || state.revision < 0) throw new Error("Device sessions unavailable");
  const sessions = state.sessions.map(value => {
    const session = record(value);
    if (session.platform !== "ios" && session.platform !== "android") throw new Error("Unsupported device platform");
    const result: DeviceSession = { threadId: string(session.threadId), hostId: string(session.hostId), deviceId: string(session.deviceId), platform: session.platform };
    return result;
  }).filter(session => session.threadId === threadId);
  const devices = state.devices.map(value => {
    const device = record(value);
    return { hostId: string(device.hostId), id: string(device.id), name: string(device.name) };
  }).filter(device => sessions.some(session => session.hostId === device.hostId && session.deviceId === device.id));
  const hosts = [...state.hosts, ...(Array.isArray(state.easHosts) ? state.easHosts : []), ...(Array.isArray(state.simlockHosts) ? state.simlockHosts : [])].map(value => {
    const host = record(value);
    return { id: string(host.id), label: string(host.label), kind: string(host.kind) };
  });
  return { revision: state.revision, hostStatus: string(state.hostStatus), sessions, devices, hosts };
}
/** Observe existing sessions only. Mounting the panel never boots or claims a device. */
export function watchDevices(threadKey: string, emit: (state: DeviceState | Error) => void, client: Pick<T3Client, "stream" | "onReconnect" | "onState"> = threadClient(threadKey)) {
  let stopped = false, generation = 0;
  let stream: ReturnType<T3Client["stream"]> | undefined;
  const error = (value: unknown) => { if (!stopped) emit(value instanceof Error ? value : new Error("Device state unavailable")); };
  const start = () => {
    if (stopped) return;
    const current = ++generation; stream?.cancel();
    stream = client.stream("subscribeDeviceState", {}, (value: unknown) => {
      if (stopped || current !== generation) return;
      try { emit(parseDeviceState(value, threadTarget(threadKey).threadId)); } catch (value) { error(value); }
    });
    void stream.done.catch(value => { if (current === generation) error(value); });
  };
  const reconnect = client.onReconnect(start);
  const connection = client.onState(state => { if (state === "closed") { generation++; error(new Error("Device connection lost. Reconnecting…")); } });
  start();
  return () => { stopped = true; generation++; stream?.cancel(); reconnect(); connection(); };
}
/** T3's read-only MJPEG fallback; keep environment, host, and device together. */
export function deviceFrameUrl(threadKey: string, session: DeviceSession, state: DeviceState): string {
  const target = threadTarget(threadKey);
  if (session.threadId !== target.threadId || !state.sessions.some(current => current.hostId === session.hostId && current.deviceId === session.deviceId)) throw new Error("The device is not open in this conversation");
  const host = state.hosts.find(host => host.id === session.hostId);
  if (!host) throw new Error("The device host is unavailable");
  const vendor = session.platform === "ios" || host.kind === "simlock" ? "serve-sim" : "serve-emu";
  return `${environmentPrefix(target.environmentId)}/api/device-hub/vendor/${vendor}/helper/${encodeURIComponent(session.deviceId)}/stream.mjpeg?${new URLSearchParams({ hostId: session.hostId })}`;
}
