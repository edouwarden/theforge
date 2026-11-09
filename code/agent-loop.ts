/**
 * The bounded model/tool loop.
 *
 * This is the loop the pipeline runs. The model is a port. The loop owns the turn,
 * the tool call, the tool result, the guard notice and the stop condition. It
 * does not know the pipeline step, the prompt text or the tool implementation.
 *
 * The production runner adds adaptive turn caps, JEV checkpoints, context
 * cleanup, trace capture and provider-specific decoding. None of that is
 * needed to show the control boundary.
 */

import { runToolCalls } from "./agent-turn"
import type { AgentInput, AgentResult, TurnRecord } from "./agent-loop-types"

/**
 * Run one bounded reason/act loop.
 *
 * A model reply without tool calls finishes the run. A reply with tool calls is
 * executed, capped and fed back as tool results. A thrown tool is a failed
 * result, not an exception that kills the loop. A guard nudge is appended as a
 * `guard` tool result; a guard abort stops the run.
 */
export async function runAgent(input: AgentInput): Promise<AgentResult> {
  const history: TurnRecord[] = []
  const usage = { inTok: 0, outTok: 0 }
  const started = Date.now()
  let lastText = ""

  for (let turn = 1; turn <= input.limits.maxTurns; turn += 1) {
    if (input.limits.deadlineMs !== undefined && Date.now() - started >= input.limits.deadlineMs) {
      return { text: lastText, turns: turn - 1, usage, stopped: "deadline", history }
    }

    const reply = await input.model.complete({
      system: input.system,
      prompt: input.buildPrompt(history),
      tools: input.tools.specs,
      temperature: input.temperature ?? 0,
      ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })

    usage.inTok += reply.usage.inTok
    usage.outTok += reply.usage.outTok
    lastText = reply.text

    if (reply.toolCalls.length === 0) {
      return { text: reply.text, turns: turn, usage, stopped: "done", history }
    }

    const turnResult = await runToolCalls(reply.toolCalls, input)
    const results = [...turnResult.results]
    if (turnResult.notices.length > 0) {
      results.push({
        name: "guard",
        ok: true,
        content: `guard: ${turnResult.notices.join("; ")}`,
      })
    }

    history.push({ assistant: reply.text, toolCalls: reply.toolCalls, results })

    if (turnResult.guardReason !== undefined) {
      return {
        text: reply.text,
        turns: turn,
        usage,
        stopped: "guard",
        history,
        guardReason: turnResult.guardReason,
      }
    }
  }

  return { text: lastText, turns: input.limits.maxTurns, usage, stopped: "turn-cap", history }
}
