/**
 * The state a pipeline run accumulates.
 *
 * Steps read artifacts from this state and write their own artifact back. Gate,
 * parse and agent failures are recorded rather than thrown, so the caller can
 * inspect where the run stopped. A deterministic step without a runner is a
 * configuration error and throws.
 */

import type { Plan, RunState } from "./pipeline-types"

export function createRunState(input: {
  task: string
  stack?: string
  repoMap?: string
}): RunState {
  return {
    task: input.task,
    stack: input.stack ?? "",
    repoMap: input.repoMap ?? "",
    artifacts: {},
    failures: [],
  }
}

/**
 * Advance a passing plan into the state the coder reads.
 *
 * The plan is the contract; the first task becomes the coder's context. The
 * runner calls this only after the plan gate passes.
 */
export function applyPlan(state: RunState, artifact: unknown): void {
  if (!isPlan(artifact)) {
    throw new Error("plan artifact is not a plan")
  }
  state.plan = artifact
  state.currentTask = artifact.tasks[0]
}

function isPlan(value: unknown): value is Plan {
  if (!isRecord(value) || !Array.isArray(value.tasks) || value.tasks.length === 0) return false
  return value.tasks.every(
    (task) => isRecord(task) && typeof task.id === "string" && typeof task.title === "string",
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
