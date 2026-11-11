// The small machine name shown next to a thread that runs on another machine, with its status dot.
import clsx from "clsx";
import { Laptop, Server } from "lucide-react";
import { useApp } from "../store";
import type { Machine } from "../lib/types";

export const MACHINE_STATUS: Record<Machine["status"], string> = { online: "Online", asleep: "Asleep", unreachable: "Unreachable", expired: "Link expired" };

export function machineDot(status: Machine["status"] | undefined) {
  return status === "online" ? "bg-success" : status === "asleep" ? "bg-attention" : status ? "bg-danger" : "bg-line-strong";
}

export function MachineBadge({ environmentId, fallback, className }: { environmentId: string; fallback?: string; className?: string }) {
  const machine = useApp((s) => s.machines?.find((candidate) => candidate.environmentId === environmentId));
  const label = machine?.label ?? fallback ?? "Another machine";
  const Icon = machine?.laptop ? Laptop : Server;
  return <span data-machine-badge={environmentId} title={`${label}${machine ? ` · ${MACHINE_STATUS[machine.status]}` : ""}`}
    className={clsx("inline-flex max-w-32 min-w-0 shrink-0 items-center gap-1 rounded-full border border-line px-1.5 py-px text-[11px] leading-4 text-muted", className)}>
    <Icon size={11} aria-hidden="true" className="shrink-0" />
    <span className="min-w-0 truncate">{label}</span>
    <span aria-hidden="true" className={clsx("size-1.5 shrink-0 rounded-full", machineDot(machine?.status))} />
  </span>;
}
