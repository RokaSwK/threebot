// Verifies Cloudflare Access tokens (Cf-Access-Jwt-Assertion header or CF_Authorization cookie).
// A valid token for an allowed email lets a request skip the app password.
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type { IncomingMessage } from "node:http";

export function createAccessVerifier({ teamDomain, aud, emails, fetchImpl = fetch, now = () => Date.now() }: {
  teamDomain?: string; aud?: string; emails?: string[];
  fetchImpl?: (url: string, init: RequestInit) => Promise<{ ok: boolean; status?: number; json(): Promise<any> }>;
  now?: () => number;
}) {
  if (!teamDomain || !aud || !emails?.length) return null;
  const issuer = `https://${teamDomain}`;
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;
  const allowed = new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  let keys = new Map<string, KeyObject>();
  let fetchedAt = 0;

  async function loadKeys(force = false) {
    if (!force && keys.size && now() - fetchedAt < 60 * 60 * 1000) return;
    if (force && now() - fetchedAt < 30 * 1000) return; // don't hammer the certs endpoint on bad kids
    const res = await fetchImpl(certsUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Access certs ${res.status}`);
    const body = await res.json();
    const next = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) if (jwk.kid) next.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
    keys = next;
    fetchedAt = now();
  }

  const b64 = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

  /** Returns the verified email, or null. */
  return async function verifyAccessToken(token: unknown): Promise<string | null> {
    if (typeof token !== "string" || token.length > 8192) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    let header, claims;
    try {
      header = JSON.parse(b64(parts[0]).toString("utf8"));
      claims = JSON.parse(b64(parts[1]).toString("utf8"));
    } catch {
      return null;
    }
    if (header.alg !== "RS256" || !header.kid) return null;
    try {
      await loadKeys();
      if (!keys.has(header.kid)) await loadKeys(true);
    } catch (e) {
      console.error("[access] could not load certs:", (e as Error).message);
      return null;
    }
    const key = keys.get(header.kid);
    if (!key) return null;
    const ok = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, b64(parts[2]));
    if (!ok) return null;
    const t = Math.floor(now() / 1000);
    const audOk = Array.isArray(claims.aud) ? claims.aud.includes(aud) : claims.aud === aud;
    if (!audOk || claims.iss !== issuer) return null;
    if (typeof claims.exp !== "number" || claims.exp + 30 < t) return null;
    if (typeof claims.nbf === "number" && claims.nbf - 30 > t) return null;
    const email = String(claims.email ?? "").toLowerCase();
    return allowed.has(email) ? email : null;
  };
}

export function accessTokenFrom(req: IncomingMessage, cookies: Record<string, string | undefined>) {
  return req.headers["cf-access-jwt-assertion"] || cookies.CF_Authorization || null;
}
