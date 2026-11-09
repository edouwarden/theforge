/**
 * Prompt rendering for one model step.
 *
 * Instructions are not context. The prompt body is the chosen context plus the
 * tool history of the current loop; the step instruction is passed separately
 * as the system prompt.
 */

import type { TurnRecord } from "./agent-loop-types"
import { buildContextPrompt } from "./pipeline-context"
import type { ContextBlock } from "./pipeline-types"

export function buildStepPrompt(
  blocks: readonly ContextBlock[],
  history: readonly TurnRecord[],
): string {
  return [buildContextPrompt(blocks), historyPrompt(history)]
    .filter((part) => part.length > 0)
    .join("\n\n")
}

function historyPrompt(history: readonly TurnRecord[]): string {
  return history
    .map((turn, index) => {
      const calls = turn.toolCalls
        .map((call) => `CALL ${call.name} ${JSON.stringify(call.args ?? {})}`)
        .join("\n")
      const results = turn.results
        .map((result) => `TOOL ${result.name} (${result.ok ? "ok" : "error"}):\n${result.content}`)
        .join("\n\n")
      return [
        `TURN ${index + 1}`,
        `ASSISTANT:\n${turn.assistant}`,
        calls,
        results,
      ]
        .filter((part) => part.length > 0)
        .join("\n\n")
    })
    .join("\n\n")
}
