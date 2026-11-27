// Starter Bot templates and portable .threebot.json export/import (secrets excluded).
import type { Bot } from "./types";

export type BotTemplate = {
  id: string;
  name: string;
  label: string;
  shape: string;
  color: string;
  does: string;
  doesNot: string;
  style: string;
};

export const BOT_TEMPLATES: BotTemplate[] = [
  {
    id: "reviewer",
    name: "Code Reviewer",
    label: "Reviews diffs, tests, and PR risks",
    shape: "gem",
    color: "blue",
    does: "Review diffs for correctness, security, and missing tests. Call out concrete blockers with file and line references.",
    doesNot: "Do not push, merge, or rewrite unrelated code without asking.",
    style: "Direct, concise, technical.",
  },
  {
    id: "triage",
    name: "Inbox Triage",
    label: "Summarizes and prioritizes incoming work",
    shape: "cloud",
    color: "teal",
    does: "Summarize incoming threads, issues, and alerts into clear action items ranked by urgency.",
    doesNot: "Do not reply externally or close items without confirmation.",
    style: "Brief bullet points, action-first.",
  },
  {
    id: "researcher",
    name: "Researcher",
    label: "Deep-dives codebases, docs, and web sources",
    shape: "hex",
    color: "purple",
    does: "Investigate questions thoroughly across code, docs, and primary sources. Cite exact paths and URLs.",
    doesNot: "Do not state unverified claims as fact.",
    style: "Structured, citation-backed.",
  },
  {
    id: "ops",
    name: "Ops Monitor",
    label: "Watches services, logs, and routines",
    shape: "star",
    color: "amber",
    does: "Check service health, recent errors, and scheduled routine outcomes. Flag regressions immediately.",
    doesNot: "Do not restart production services or rotate secrets without approval.",
    style: "Calm, metric-driven, alert-focused.",
  },
];

export type PortableBotBundle = {
  format: "threebot-bot-v1";
  name: string;
  label: string;
  shape: string;
  color: string;
  does?: string;
  doesNot?: string;
  style?: string;
  instructions?: string;
};

export function exportBotBundle(bot: Bot, instructions = ""): PortableBotBundle {
  return {
    format: "threebot-bot-v1",
    name: bot.name,
    label: bot.label ?? "",
    shape: bot.shape,
    color: bot.color,
    ...(instructions ? { instructions } : {}),
  };
}

export function parseBotBundle(raw: string): PortableBotBundle {
  const parsed = JSON.parse(raw) as Partial<PortableBotBundle>;
  if (!parsed || typeof parsed !== "object" || parsed.format !== "threebot-bot-v1" || typeof parsed.name !== "string" || !parsed.name.trim()) {
    throw new Error("Invalid .threebot.json bundle");
  }
  return {
    format: "threebot-bot-v1",
    name: parsed.name.trim().slice(0, 80),
    label: typeof parsed.label === "string" ? parsed.label.slice(0, 140) : "",
    shape: typeof parsed.shape === "string" && parsed.shape ? parsed.shape : "ball",
    color: typeof parsed.color === "string" && parsed.color ? parsed.color : "teal",
    does: typeof parsed.does === "string" ? parsed.does : undefined,
    doesNot: typeof parsed.doesNot === "string" ? parsed.doesNot : undefined,
    style: typeof parsed.style === "string" ? parsed.style : undefined,
    instructions: typeof parsed.instructions === "string" ? parsed.instructions : undefined,
  };
}
