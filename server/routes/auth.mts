// Authentication routes: /api/login, /api/logout, /api/session.
import type { IncomingMessage } from "node:http";
import { createRouter, type SendFn } from "./router.mts";

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10_000;

export function createAuthRoutes({
  cookieName,
  makeSession,
  passwordRequired,
  passwordMatches,
  authed,
  hasAccess,
  readBody,
  send,
  isHttps,
}: {
  cookieName: string;
  makeSession: () => string;
  passwordRequired: () => Promise<boolean>;
  passwordMatches: (password: string) => Promise<boolean>;
  authed: (req: IncomingMessage) => Promise<boolean>;
  hasAccess: boolean;
  readBody: (req: IncomingMessage, limit?: number) => Promise<any>;
  send: SendFn;
  isHttps: (req: IncomingMessage) => boolean;
}) {
  // Login attempts per client: 5 failures lock that client out for 15 minutes.
  // Bounded and pruned so long-running gateways cannot leak memory.
  const attempts = new Map<string, { count: number; last: number }>();

  function pruneAttempts(now = Date.now()) {
    for (const [key, entry] of attempts) {
      if (now - entry.last >= ATTEMPT_WINDOW_MS) attempts.delete(key);
    }
    while (attempts.size >= MAX_ATTEMPTS) {
      const oldest = attempts.keys().next().value;
      if (oldest === undefined) break;
      attempts.delete(oldest);
    }
  }

  function clientIp(req: IncomingMessage) {
    // The last hop is the one our proxy (Tailscale Funnel) added; earlier entries come from the client.
    return String(req.headers["x-forwarded-for"] ?? "").split(",").pop()!.trim() || req.socket.remoteAddress || "?";
  }

  function loginBlocked(ip: string) {
    const a = attempts.get(ip);
    if (!a) return false;
    if (Date.now() - a.last >= ATTEMPT_WINDOW_MS) {
      attempts.delete(ip);
      return false;
    }
    return a.count >= 5;
  }

  function loginFailed(ip: string) {
    const now = Date.now();
    pruneAttempts(now);
    const a = attempts.get(ip);
    const fresh = !a || now - a.last > ATTEMPT_WINDOW_MS;
    attempts.set(ip, { count: fresh ? 1 : a.count + 1, last: now });
  }

  const router = createRouter();

  router.post("/api/login", async ({ req, res }) => {
    const ip = clientIp(req);
    if (loginBlocked(ip)) return send(res, 429, { error: "Too many attempts. Try again in 15 minutes." });
    const { password } = await readBody(req, 4096);
    const ok = !(await passwordRequired()) || (await passwordMatches(password));
    if (!ok) {
      loginFailed(ip);
      console.warn(`failed login from ${ip}`);
      return send(res, 401, { error: "wrong password" });
    }
    attempts.delete(ip);
    const secure = isHttps(req) ? "; Secure" : "";
    return send(res, 200, { ok: true }, { "set-cookie": `${cookieName}=${makeSession()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 3600}${secure}` });
  });

  router.any("/api/session", async ({ req, res }) => {
    const needsPassword = await passwordRequired();
    // Cloudflare's login only helps requests that came through Cloudflare; on this machine or the LAN, use the password.
    const accessLogin = hasAccess && !(needsPassword && !req.headers["cf-ray"]);
    return send(res, 200, { authenticated: await authed(req), passwordRequired: needsPassword, accessLogin });
  });

  router.any("/api/logout", ({ res }) => {
    return send(res, 200, { ok: true }, { "set-cookie": `${cookieName}=; Path=/; Max-Age=0` });
  });

  return {
    handle: router.handle,
    clearAttempts: () => attempts.clear(),
  };
}
