import { memo } from "react";
import { decodePlan, useRuntimePlan, type WorkPlan } from "../lib/runtimeApi";
import { RichMarkdown } from "./RichMarkdown";

// Plans from T3 are conversation content, without a separate planning UI.
export const PlanMessage = memo(function PlanMessage({ plan }: { plan: WorkPlan }) {
  const text = plan.kind === "proposed_plan"
    ? plan.markdown
    : [...plan.steps.map(step => `- [${step.status === "completed" ? "x" : " "}] ${step.text}`), plan.explanation].filter(Boolean).join("\n\n");
  return text ? <div className="my-2 flex max-w-[92%] flex-col items-start"><div className="md bubble rounded-[18px] bg-bubble-bot px-3.5 py-[7px] text-[14px] leading-[22px] break-words"><RichMarkdown>{text}</RichMarkdown></div></div> : null;
});

export const PlanItemMessage = memo(function PlanItemMessage({ item, threadId }: { item: unknown; threadId: string }) {
  const plan = decodePlan(item);
  const artifact = useRuntimePlan(threadId, plan?.id ?? "");
  const current = artifact && !artifact.detailInTurnItem ? artifact : plan;
  return current ? <PlanMessage plan={current} /> : null;
});
