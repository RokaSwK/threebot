// Reads password-manager CSV exports in the browser. The file never leaves this device;
// only the parsed items are sent to the gateway to be saved.
import type { ContactKind, ImportItem } from "./vault";

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

export type CsvFormat = "1Password" | "Chrome or Edge" | "Safari or Apple Passwords" | "Firefox" | "Bitwarden" | "LastPass" | "Bot contact info" | "CSV";

export type CsvImport = { format: CsvFormat; items: ImportItem[]; skipped: number };

const ALIASES: Record<string, string[]> = {
  title: ["name", "title"],
  url: ["url", "login_uri", "website", "urls", "login url", "web site", "uri", "location"],
  username: ["username", "login_username", "user name", "login", "login name", "email", "user"],
  password: ["password", "login_password"],
  note: ["note", "notes", "extra", "comments", "comment"],
};

function detect(h: string[]): CsvFormat {
  const has = (k: string) => h.includes(k);
  if (has("street") || (has("kind") && has("label") && !has("password"))) return "Bot contact info";
  if (has("login_uri") || has("login_password")) return "Bitwarden";
  if (has("httprealm") || has("formactionorigin") || has("timepasswordchanged")) return "Firefox";
  if (has("grouping") || (has("extra") && has("url"))) return "LastPass";
  if (has("otpauth") && (has("favorite") || has("archived") || has("tags"))) return "1Password";
  if (has("otpauth") && has("title")) return "Safari or Apple Passwords";
  if (has("title") && (has("website") || has("url")) && has("password")) return "1Password";
  if (has("name") && has("url") && has("password")) return "Chrome or Edge";
  return "CSV";
}

function hostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function parseVaultCsv(text: string): CsvImport {
  const rows = parseCsv(text);
  if (rows.length < 2) return { format: "CSV", items: [], skipped: 0 };
  const header = rows[0].map((c) => c.trim().toLowerCase());
  const format = detect(header);
  const col = (row: string[], names: string[]) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i !== -1 && row[i]?.trim()) return row[i];
    }
    return "";
  };
  const items: ImportItem[] = [];
  let skipped = 0;

  // Bot exports append JSON arrays only when there are repeated values. Other
  // password-manager formats retain their original scalar columns.
  const repeatedColumn = (row: string[], name: string): string[] | null | undefined => {
    const raw = col(row, [name]);
    if (!raw) return undefined;
    try {
      const value: unknown = JSON.parse(raw);
      return Array.isArray(value) && value.length <= 20 && value.every((entry): entry is string => typeof entry === "string" && entry.length <= 4000) ? value : null;
    } catch { return null; }
  };
  for (const row of rows.slice(1)) {
    const websites = repeatedColumn(row, "websites");
    const emails = repeatedColumn(row, "emails");
    const phones = repeatedColumn(row, "phones");
    if (websites === null || emails === null || phones === null) { skipped++; continue; }
    if (format === "Bot contact info") {
      const get = (k: string) => col(row, [k]).trim();
      const kind = get("kind").toLowerCase();
      const c = {
        type: "contact" as const,
        label: get("label"),
        name: get("name"),
        email: get("email"),
        ...(emails ? { emails } : {}),
        phone: get("phone"),
        ...(phones ? { phones } : {}),
        street: get("street"),
        apt: get("apt"),
        city: get("city"),
        state: get("state"),
        zip: get("zip"),
        country: get("country"),
        kind: (["home", "work", "other"].includes(kind) ? kind : "home") as ContactKind,
        hints: get("note") || get("hints"),
      };
      if (c.label || c.name || c.email || c.phone || c.street) items.push(c);
      else skipped++;
      continue;
    }
    // Bitwarden exports notes and cards too; LastPass marks secure notes with http://sn.
    const type = col(row, ["type"]).trim().toLowerCase();
    if (format === "Bitwarden" && type && type !== "login") {
      skipped++;
      continue;
    }
    let url = col(row, ALIASES.url).trim();
    if (format === "LastPass" && /^https?:\/\/sn\/?$/i.test(url)) {
      skipped++;
      continue;
    }
    // Several URIs in one field (Bitwarden, 1Password): keep the first.
    url = url.split(/[,\s]+/).find(Boolean) ?? "";
    const password = col(row, ALIASES.password);
    const username = col(row, ALIASES.username).trim();
    const title = col(row, ALIASES.title).trim() || hostname(url);
    if (!password && !username) {
      skipped++;
      continue;
    }
    if (!url && !title) {
      skipped++;
      continue;
    }
    items.push({ type: "login", title, website: url, ...(websites ? { websites } : {}), username, password, hints: col(row, ALIASES.note).trim() });
  }
  return { format, items, skipped };
}
