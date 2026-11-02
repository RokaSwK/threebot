import { memo } from "react";
import {
  activeWork,
  currentGoal,
  goalControls,
  messageCommand,
  useWorkCommand,
  type WorkState,
} from "../lib/runtimeApi";
import { Pill } from "./ui";
import { WorkFeedback } from "./QueuedWork";

export const GoalCard = memo(function GoalCard({
  threadId,
  state,
  readOnly = false,
}: {
  threadId: string;
  state: WorkState;
  readOnly?: boolean;
}) {
  const source = currentGoal(state),
    goal = source?.goal;
  const action = useWorkCommand(JSON.stringify(source));
  if (!source || !goal) return null;
  return (
    <section
      aria-label="Persistent goal"
      className="my-2 w-full max-w-[560px] rounded-[18px] border border-line bg-card p-3.5"
    >
      <div className="mb-2 flex items-center justify-between text-[13px]">
        <span>Goal</span>
        <span className="text-[12px] text-muted">
          {goal.status.replaceAll("_", " ")}
        </span>
      </div>
      <p className="text-[14px] leading-5 [overflow-wrap:anywhere]">
        {goal.objective}
      </p>
      {(goal.tokensUsed !== null || goal.timeUsedSeconds !== null) && (
        <p className="mt-2 text-[12px] text-muted">
          {goal.tokensUsed !== null &&
            `${goal.tokensUsed.toLocaleString()}${goal.tokenBudget !== null ? ` / ${goal.tokenBudget.toLocaleString()}` : ""} tokens`}
          {goal.tokensUsed !== null && goal.timeUsedSeconds !== null && " · "}
          {goal.timeUsedSeconds !== null &&
            `${Math.floor(goal.timeUsedSeconds / 60)}m ${Math.floor(goal.timeUsedSeconds % 60)}s`}
        </p>
      )}
      {!readOnly && (
        <div className="mt-3 flex gap-2">
          {goalControls(source.driver, goal).map((control) => (
            <Pill
              key={control}
              disabled={action.disabled}
              onClick={() =>
                void action.send(
                  messageCommand(
                    threadId,
                    `/goal ${control}`,
                    !!activeWork(state),
                  ),
                )
              }
            >
              {control === "resume"
                ? "Resume"
                : control === "pause"
                  ? "Pause"
                  : "Clear goal"}
            </Pill>
          ))}
        </div>
      )}
      <WorkFeedback action={action} />
    </section>
  );
});
