// Webhook routine trigger routes: POST /api/webhooks/:routineId.
import { createRouter, type SendFn } from "./router.mts";
import { safeEqual } from "../safe-equal.mts";
import type { IncomingMessage } from "node:http";

export function createWebhookRoutes({
  webhookToken,
  authed,
  runRoutine,
  recordAudit,
  send,
}: {
  webhookToken?: string;
  authed: (req: IncomingMessage) => Promise<boolean>;
  runRoutine: (routineId: string) => Promise<unknown>;
  recordAudit: (entry: { action: string; target?: string; status?: "ok" | "error" | "denied" }) => void;
  send: SendFn;
}) {
  const router = createRouter();

  router.post(/^\/api\/webhooks\/([\w:%.-]{1,600})$/, async ({ req, res, match }) => {
    const routineId = decodeURIComponent(match![1]);
    const header = String(req.headers.authorization ?? "");
    const bearer = /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? "";
    const tokenOk = Boolean(webhookToken && bearer && safeEqual(bearer, webhookToken));
    if (!tokenOk && !(await authed(req))) {
      recordAudit({ action: "webhook.trigger", target: routineId, status: "denied" });
      return send(res, 401, { error: "unauthorized" });
    }
    try {
      await runRoutine(routineId);
      recordAudit({ action: "webhook.trigger", target: routineId, status: "ok" });
      return send(res, 202, { ok: true, routineId }, { "cache-control": "no-store" });
    } catch (error) {
      recordAudit({ action: "webhook.trigger", target: routineId, status: "error" });
      return send(res, 502, { error: error instanceof Error ? error.message : "Couldn't trigger routine" });
    }
  });

  return { handle: router.handle };
}
