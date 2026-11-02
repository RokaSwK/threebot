// The Vault as the app sees it. Passwords never come with the list; the item dialog
// asks for one only when the user reveals or copies it.

export type VaultLogin = {
  id: string;
  type: "login";
  title: string;
  website?: string;
  websites?: string[];
  username?: string;
  hints?: string;
  domain: string;
  hasPassword: boolean;
  /** An API token or key the Bots may read; other passwords are only filled into pages. */
  botCanRead?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ContactKind = "home" | "work" | "other";

export type VaultContact = {
  id: string;
  type: "contact";
  title: string;
  label?: string;
  name?: string;
  email?: string;
  emails?: string[];
  phone?: string;
  phones?: string[];
  street?: string;
  apt?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  kind?: ContactKind;
  hints?: string;
  createdAt: string;
  updatedAt: string;
};

export type VaultItem = VaultLogin | VaultContact;

export type LoginInput = { title?: string; website?: string; websites?: string[]; username?: string; password?: string; hints?: string; botCanRead?: boolean };
export type ContactInput = Partial<Omit<VaultContact, "id" | "type" | "createdAt" | "updatedAt">>;
export type ImportItem = ({ type: "login" } & LoginInput) | ({ type: "contact" } & ContactInput);

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: init.body ? { "content-type": "application/json" } : undefined, cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body as T;
}

export const vaultApi = {
  list: () => req<{ items: VaultItem[] }>("/api/vault").then((r) => r.items),
  reveal: (id: string) => req<VaultLogin & { password?: string }>(`/api/vault/${id}?reveal=1`),
  create: (item: ImportItem) => req<VaultItem>("/api/vault", { method: "POST", body: JSON.stringify(item) }),
  update: (id: string, patch: LoginInput | ContactInput) => req<VaultItem>(`/api/vault/${id}`, { method: "PUT", body: JSON.stringify(patch) }),
  remove: (id: string) => req<{ ok: true }>(`/api/vault/${id}`, { method: "DELETE" }),
  import: (items: ImportItem[]) => req<{ added: number; updated: number; skipped: number }>("/api/vault/import", { method: "POST", body: JSON.stringify({ items }) }),
};

export const exportUrl = (type: "login" | "contact") => `/api/vault/export.csv${type === "contact" ? "?type=contact" : ""}`;

/** Same rule as the gateway: the website's hostname without a leading "www.". */
export function siteDomain(website: string | undefined | null): string {
  const s = String(website ?? "").trim();
  if (!s) return "";
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== "https:" && u.protocol !== "http:") return "";
    return u.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function siteUrl(website: string | undefined | null): string | null {
  const s = String(website ?? "").trim();
  if (!siteDomain(s)) return null;
  return /^https?:\/\//i.test(s) ? s : `https://${s}`;
}


export function contactSummary(c: ContactInput): string {
  const place = [c.city, c.state].filter(Boolean).join(", ");
  return [c.name, ...(c.emails ?? [c.email]), ...(c.phones ?? [c.phone]), place].filter(Boolean).join(" · ");
}

export function addressLines(c: ContactInput): string[] {
  return [[c.street, c.apt].filter(Boolean).join(", "), [c.city, [c.state, c.zip].filter(Boolean).join(" ")].filter(Boolean).join(", "), c.country ?? ""].filter((l) => l.trim());
}
