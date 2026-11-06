// Minimal T3 Code client (orchestration protocol 2; checked against v0.1.5 through 0.1.8).
// Transport: Effect RPC over WebSocket, JSON serialization, one message per frame.
// Uses Node's built-in WebSocket (Node >= 22) and fetch; no dependencies.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// RPC results and stream items are T3 Code's own JSON payloads; this client does not model their schema.
type RpcValue = any;
type Pending = { resolve: (value: RpcValue) => void; reject: (error: unknown) => void; onChunk?: (item: RpcValue) => void };

export function loadToken(path: string): string {
  if (process.env.T3_TOKEN) return process.env.T3_TOKEN.trim();
  return readFileSync(path, "utf8").trim();
}

export class T3Client {
  declare baseUrl: string;
  declare token: string;
  declare clientLabel: string;
  declare nextId: number;
  declare pending: Map<string, Pending>;
  declare ws: WebSocket;
  declare pingTimer: ReturnType<typeof setInterval>;

  constructor({ baseUrl, token, clientLabel = "bot" }: { baseUrl: string; token: string; clientLabel?: string }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.clientLabel = clientLabel;
    this.nextId = 1;
    this.pending = new Map(); // requestId -> { resolve, reject, onChunk }
  }

  async http(path: string, init: RequestInit = {}): Promise<RpcValue> {
    const res = await fetch(this.baseUrl + path, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, ...(init.headers ?? {}) },
    });
    const text = await res.text();
    let body: RpcValue;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} ${path}`), { body });
    return body;
  }

  async connect() {
    // Browsers cannot set Authorization on a WebSocket, so T3 mints a short-lived ticket.
    // (With the `ws` package you could instead send `Authorization: Bearer ...` on the upgrade.)
    const { ticket } = await this.http("/api/auth/websocket-ticket/rpc", { method: "POST" });
    const url = new URL(this.baseUrl.replace(/^http/, "ws") + "/ws");
    url.searchParams.set("orchestrationProtocol", "2"); // required, else HTTP 426
    url.searchParams.set("wsTicket", ticket);
    url.searchParams.set("clientSurface", "web");
    this.ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", (e) => reject((e as ErrorEvent).error ?? new Error("ws error")), { once: true });
    });
    this.ws.addEventListener("message", (ev) => this.#onMessage(ev.data));
    this.ws.addEventListener("close", (ev) => {
      for (const p of this.pending.values()) p.reject(new Error(`socket closed ${ev.code} ${ev.reason}`));
      this.pending.clear();
    });
    this.pingTimer = setInterval(() => this.#send({ _tag: "Ping" }), 10_000);
  }

  close() {
    clearInterval(this.pingTimer);
    try { this.#send({ _tag: "Eof" }); } catch {}
    this.ws?.close();
  }

  #send(msg: Record<string, unknown>) { this.ws.send(JSON.stringify(msg)); }

  #onMessage(raw: string | ArrayBuffer) {
    const data = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    for (const msg of Array.isArray(data) ? data : [data]) {
      if (msg._tag === "Pong") continue;
      if (msg._tag === "Defect") { console.error("[rpc defect]", JSON.stringify(msg.defect)); continue; }
      const p = this.pending.get(String(msg.requestId));
      if (!p) continue;
      if (msg._tag === "Chunk") {
        // Server waits for an Ack before sending the next chunk of a stream.
        this.#send({ _tag: "Ack", requestId: String(msg.requestId) });
        for (const v of msg.values) p.onChunk?.(v);
      } else if (msg._tag === "Exit") {
        this.pending.delete(String(msg.requestId));
        const exit = msg.exit;
        if (exit._tag === "Success") p.resolve(exit.value);
        else p.reject(Object.assign(new Error(describeCause(exit.cause)), { cause: exit.cause }));
      }
    }
  }

  /** Unary RPC. */
  call(tag: string, payload: object = {}): Promise<RpcValue> {
    const id = String(this.nextId++);
    return new Promise<RpcValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.#send({ _tag: "Request", id, tag, payload, headers: [] });
    });
  }

  /** Streaming RPC. Returns { done: Promise, cancel() }. */
  stream(tag: string, payload: unknown, onItem: (item: RpcValue) => void): { done: Promise<unknown>; cancel: () => void } {
    const id = String(this.nextId++);
    let cancelled = false;
    // A cancelled stream resolves with no value.
    const done = new Promise<RpcValue>((resolve: (value?: RpcValue) => void, reject) => {
      this.pending.set(id, {
        resolve,
        // A cancelled stream ends with an Exit whose cause is [{_tag:"Interrupt"}...]; treat as normal end.
        reject: (err: unknown) => (cancelled ? resolve() : reject(err)),
        onChunk: onItem,
      });
    });
    done.catch(() => {}); // callers that care should await `done`
    this.#send({ _tag: "Request", id, tag, payload, headers: [] });
    return {
      done,
      cancel: () => { cancelled = true; this.#send({ _tag: "Interrupt", requestId: id }); },
    };
  }

  dispatch(command: object): Promise<RpcValue> {
    return this.call("orchestration.dispatchCommand", { commandId: randomUUID(), ...command });
  }
}

// The cause is T3's encoded Effect Cause, so its shape is checked field by field below.
function describeCause(cause: RpcValue): string {
  if (!cause) return "unknown failure";
  // Effect v4 encodes a Cause as an array of reasons: [{_tag:"Fail",error}|{_tag:"Die",defect}|{_tag:"Interrupt"}]
  if (Array.isArray(cause)) return cause.map(describeCause).join("; ");
  if (cause._tag === "Interrupt") return "interrupted";
  if (cause._tag === "Fail") return JSON.stringify(cause.error);
  if (cause._tag === "Die") return "defect: " + JSON.stringify(cause.defect);
  if (Array.isArray(cause.failures)) return cause.failures.map(describeCause).join("; ");
  return JSON.stringify(cause);
}

export { randomUUID };
