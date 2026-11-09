/**
 * The pipeline runner.
 *
 * This is the file to read first. The steps declare what they may see and do;
 * this file only sequences them, applies gates and records failures. Context
 * selection, step declarations, parsing, prompt rendering and tool policy live
 * beside it.
 */

import { runAgent } from "./agent-loop"
import type { AgentResult } from "./agent-loop-types"
import { selectContext } from "./pipeline-context"
import { buildStepPrompt } from "./pipeline-prompt"
import { DEFAULT_STEPS } from "./pipeline-steps"
import { allowTools } from "./pipeline-tools"
import type {
  ContextBlock,
  GateResult,
  PipelineOptions,
  PipelineResult,
  Step,
  StepResult,
} from "./pipeline-types"

type StepOutcome =
  | { ok: true; artifact: unknown; agent?: AgentResult }
  | { ok: false; artifact: unknown; gate: GateResult; agent?: AgentResult }

/**
 * Run the declared steps in order.
 *
 * A step's context is selected before it runs, its artifact is parsed and
 * gated, and only a passing artifact advances to the next step. A failed gate,
 * a parse failure or a step error stops the pipeline with the reason recorded.
 *
 * The default table is env, plan, build and harden. The full declaration in
 * `pipeline-steps.ts` adds integrate, whose runner is private.
 */
export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const steps = options.steps ?? DEFAULT_STEPS
  const results: StepResult[] = []

  for (const step of steps) {
    const selection = selectContext(step, options.state)
    options.onEvent?.({ type: "step.start", step: step.id, manifest: selection.manifest })

    const outcome = await runStep(step, options, selection.blocks)
    let gate = outcome.ok ? await checkGate(options, step, outcome.artifact) : outcome.gate

    if (gate.ok) {
      try {
        step.apply?.(options.state, outcome.artifact)
        options.state.artifacts[step.id] = outcome.artifact
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        gate = { ok: false, reason: `state transition failed: ${message}` }
      }
    }

    const result: StepResult = {
      step: step.id,
      artifact: outcome.artifact,
      manifest: selection.manifest,
      gate,
      ...(outcome.agent !== undefined ? { agent: outcome.agent } : {}),
    }
    results.push(result)
    options.onEvent?.({ type: "step.end", step: step.id, manifest: selection.manifest, gate })

    if (!gate.ok) {
      options.state.failures.push({ step: step.id, reason: gate.reason ?? "gate failed" })
      return { ok: false, steps: results, state: options.state, failedAt: step.id, gate }
    }
  }

  return { ok: true, steps: results, state: options.state }
}

/** A gate is external code; a throw is a failed gate, not a crashed pipeline. */
async function checkGate(
  options: PipelineOptions,
  step: Step,
  artifact: unknown,
): Promise<GateResult> {
  try {
    return await options.gates.check(step.gate, artifact, options.state)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `gate error: ${message}` }
  }
}

/** Run one step: a model loop with a parser, or a deterministic runner. */
async function runStep(
  step: Step,
  options: PipelineOptions,
  blocks: readonly ContextBlock[],
): Promise<StepOutcome> {
  if (step.kind === "deterministic") {
    if (step.run === undefined) {
      throw new Error(`step "${step.id}": deterministic runner is not included in the public slice`)
    }
    try {
      return { ok: true, artifact: await step.run(options.state) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ok: false,
        artifact: undefined,
        gate: { ok: false, reason: `step runner failed: ${message}` },
      }
    }
  }

  let agent: AgentResult
  try {
    agent = await runAgent({
      model: options.model,
      tools: allowTools(options.tools, step.tools),
      guard: options.guard,
      system: step.instruction,
      buildPrompt: (history) => buildStepPrompt(blocks, history),
      limits: {
        maxTurns: step.maxTurns ?? 12,
        ...(step.deadlineMs !== undefined ? { deadlineMs: step.deadlineMs } : {}),
      },
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      artifact: undefined,
      gate: { ok: false, reason: `agent error: ${message}` },
    }
  }

  if (agent.stopped !== "done") {
    return {
      ok: false,
      artifact: agent.text,
      gate: { ok: false, reason: stopReason(agent) },
      agent,
    }
  }

  try {
    return {
      ok: true,
      artifact: step.parse ? step.parse(agent.text) : agent.text,
      agent,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      artifact: agent.text,
      gate: { ok: false, reason: `output did not parse: ${message}` },
      agent,
    }
  }
}

function stopReason(agent: AgentResult): string {
  return agent.stopped === "guard"
    ? `agent stopped by guard: ${agent.guardReason ?? "loop"}`
    : `agent stopped: ${agent.stopped}`
}
