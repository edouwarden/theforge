/**
 * JEV is an optional, cheap LLM sidecar.
 *
 * It answers small `score`, `choice` and `noul` questions so the pipeline can
 * pick among paths it already has. It is not a step and not a detector: it
 * writes no code, chooses no step and overrides no gate.
 *
 * The rubric, prompts and weights stay private. This module publishes the
 * interface and the fallback behaviour: a timeout, malformed payload or
 * low-confidence choice returns nothing, and the caller keeps its deterministic
 * path.
 */

import { parseJevAnswers } from "./jev-parse"
import type { JevAnswers, JevPort, JevQuestion } from "./jev-types"

export const DEFAULT_JEV_TIMEOUT_MS = 1_000
export const DEFAULT_CHOICE_CONFIDENCE = 0.5
export const MAX_QUESTIONS_PER_BATCH = 6

/**
 * Ask the sidecar and validate the answer.
 *
 * Never throws. A missing port, timeout, provider error or payload with no
 * usable answer returns null, which means "use the deterministic path".
 */
export async function askJev(
  port: JevPort | undefined,
  questions: readonly JevQuestion[],
  state: string,
  opts: { timeoutMs?: number } = {},
): Promise<JevAnswers | null> {
  if (!port || questions.length === 0) return null

  const timeoutMs = opts.timeoutMs ?? DEFAULT_JEV_TIMEOUT_MS
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(null)
    }, timeoutMs)
  })

  try {
    const raw = await Promise.race([
      port.ask(questions, state, { signal: controller.signal }),
      timeout,
    ])
    if (raw === null || raw === undefined) return null
    return parseJevAnswers(raw, questions)
  } catch {
    return null
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function readScore(
  answers: JevAnswers | null | undefined,
  id: string,
): number | undefined {
  const answer = answers?.[id]
  return answer?.type === "score" ? answer.value : undefined
}

export function readChoice(
  answers: JevAnswers | null | undefined,
  id: string,
  minConfidence = DEFAULT_CHOICE_CONFIDENCE,
): string | undefined {
  const answer = answers?.[id]
  if (answer?.type !== "choice" || answer.confidence < minConfidence) return undefined
  return answer.option
}

export function readNoul(
  answers: JevAnswers | null | undefined,
  id: string,
): number | undefined {
  const answer = answers?.[id]
  return answer?.type === "noul" ? answer.probability : undefined
}

/** Split questions into provider-sized batches, preserving order. */
export function batchQuestions(
  questions: readonly JevQuestion[],
  max = MAX_QUESTIONS_PER_BATCH,
): JevQuestion[][] {
  const size = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1
  const batches: JevQuestion[][] = []
  for (let index = 0; index < questions.length; index += size) {
    batches.push(questions.slice(index, index + size))
  }
  return batches
}
