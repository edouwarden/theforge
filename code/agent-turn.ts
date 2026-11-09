/**
 * One turn of tool calls inside the agent loop.
 *
 * The guard observes before and after each call and once per turn. A nudge is
 * collected for the caller; an abort stops the turn. The results are returned
 * in call order so the loop can feed them back to the model.
 */

import { runTool } from "./agent-tools"
import type { AgentInput, GuardAction, ToolCall, ToolResult } from "./agent-loop-types"

const NONE: GuardAction = { kind: "none" }

export interface TurnToolResult {
  results: ToolResult[]
  notices: string[]
  guardReason?: string
}

/**
 * Execute the tool calls of one model reply.
 *
 * A guard nudge does not stop execution; it is recorded and the caller injects
 * it as a `guard` tool result. A guard abort stops the remaining calls.
 */
export async function runToolCalls(
  calls: readonly ToolCall[],
  input: Pick<AgentInput, "tools" | "guard" | "limits">,
): Promise<TurnToolResult> {
  const results: ToolResult[] = []
  const notices: string[] = []
  let wroteSomething = false
  let guardReason: string | undefined

  for (const call of calls) {
    const before = input.guard.observeCall?.(call) ?? NONE
    if (before.kind === "nudge") notices.push(before.reason)
    if (before.kind === "abort") {
      guardReason = before.reason
      break
    }

    const spec = input.tools.specs.find((candidate) => candidate.name === call.name)
    const result = await runTool(input.tools, spec, call, input.limits.maxToolResultChars)

    if (result.ok && spec?.writes === true) wroteSomething = true
    results.push(result)

    const after = input.guard.observeResult?.(call, result) ?? NONE
    if (after.kind === "nudge") notices.push(after.reason)
    if (after.kind === "abort") {
      guardReason = after.reason
      break
    }
  }

  const turnAction = input.guard.observeTurn({ results, wroteSomething })
  if (turnAction.kind === "nudge") notices.push(turnAction.reason)
  if (turnAction.kind === "abort") guardReason = turnAction.reason

  return {
    results,
    notices,
    ...(guardReason !== undefined ? { guardReason } : {}),
  }
}
