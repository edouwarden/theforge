/**
 * Per-step context selection.
 *
 * Context is chosen from the artifacts produced so far, not copied from a
 * global transcript. Required blocks are always kept. Optional blocks are kept
 * in order until the step's budget is exhausted, and the manifest records what
 * was dropped and why.
 */

import type {
  ContextBlock,
  ContextKind,
  ContextManifest,
  ContextSelection,
  DroppedContextBlock,
  RunState,
  Step,
} from "./pipeline-types"

/**
 * Select the blocks one step may see.
 *
 * A step can exceed its budget only through required context, which is exactly
 * the case the manifest must make visible.
 */
export function selectContext(step: Step, state: RunState): ContextSelection {
  const blocks = step.context(state)
  const required = blocks.filter((block) => block.required)
  const optional = blocks.filter((block) => !block.required)
  const requiredTokens = required.reduce((sum, block) => sum + block.tokens, 0)

  let remaining = Math.max(0, step.contextBudget - requiredTokens)
  const keptOptional: ContextBlock[] = []
  const dropped: DroppedContextBlock[] = []

  for (const block of optional) {
    if (block.tokens <= remaining) {
      keptOptional.push(block)
      remaining -= block.tokens
    } else {
      dropped.push({
        id: block.id,
        reason: `over budget: ${block.tokens} tokens, ${remaining} left`,
      })
    }
  }

  const kept = [...required, ...keptOptional]
  const tokens = kept.reduce((sum, block) => sum + block.tokens, 0)

  return {
    blocks: kept,
    manifest: manifestOf(step, kept, tokens, dropped),
  }
}

/** Create one typed context block and estimate its size. */
export function contextBlock(input: {
  id: string
  kind: ContextKind
  source: string
  text: string
  required?: boolean
}): ContextBlock {
  const required = input.required ?? false
  return {
    id: input.id,
    kind: input.kind,
    source: input.source,
    text: input.text,
    required,
    tokens: estimateTokens(input.text),
  }
}

/** Render the chosen blocks as the context part of a prompt. */
export function buildContextPrompt(blocks: readonly ContextBlock[]): string {
  return blocks
    .filter((block) => block.text.length > 0)
    .map((block) => `[${block.kind}:${block.source}]\n${block.text}`)
    .join("\n\n")
}

/** A deliberately simple estimate: four characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function manifestOf(
  step: Step,
  blocks: readonly ContextBlock[],
  tokens: number,
  dropped: readonly DroppedContextBlock[],
): ContextManifest {
  return {
    step: step.id,
    blocks: blocks.map(({ id, kind, source, tokens: blockTokens, required }) => ({
      id,
      kind,
      source,
      tokens: blockTokens,
      required,
    })),
    tokens,
    budget: step.contextBudget,
    overBudget: tokens > step.contextBudget,
    dropped,
  }
}
