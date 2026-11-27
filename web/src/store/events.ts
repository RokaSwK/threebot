// Unified gateway SSE client (/api/events) with automatic reconnect.
let source: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 1_000;
let hadConnection = false;

export type GatewayEventHandlers = {
  onBots: () => void;
  onRooms: () => void;
  onMachines: () => void;
  onReconnect: () => void;
};

export function startGatewayEvents(handlers: GatewayEventHandlers) {
  if (source || typeof EventSource === "undefined") return;

  const connect = () => {
    if (source || typeof EventSource === "undefined") return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const es = new EventSource("/api/events");
    source = es;

    es.addEventListener("hello", () => {
      backoffMs = 1_000;
      if (hadConnection) handlers.onReconnect();
      hadConnection = true;
    });
    es.addEventListener("bots", () => handlers.onBots());
    es.addEventListener("rooms", () => handlers.onRooms());
    es.addEventListener("machines", () => handlers.onMachines());
    es.onerror = () => {
      if (source !== es) return;
      es.close();
      source = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const delay = backoffMs;
      backoffMs = Math.min(30_000, backoffMs * 2);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };
  };

  connect();
}

export function stopGatewayEvents() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (source) {
    source.close();
    source = null;
  }
  hadConnection = false;
  backoffMs = 1_000;
}
