/**
 * Payload validation for the JEV sidecar.
 *
 * The provider is a model, so its output is untrusted. Unknown questions and
 * malformed answers are skipped. If no answer survives, the result is null and
 * the caller keeps its deterministic path.
 */

import type { JevAnswers, JevQuestion } from "./jev-types"

/** Validate and clamp a raw payload. Unknown questions are ignored. */
export function parseJevAnswers(
  raw: unknown,
  questions: readonly JevQuestion[],
): JevAnswers | null {
  if (!isRecord(raw)) return null

  const answers: JevAnswers = {}
  for (const question of questions) {
    const entry = raw[question.id]
    if (entry === undefined) continue

    if (question.type === "score") {
      const value = numberField(entry, "value")
      if (value === undefined) continue
      answers[question.id] = {
        type: "score",
        value: clamp01(value),
        confidence: clamp01(numberField(entry, "confidence") ?? 1),
      }
      continue
    }

    if (question.type === "choice") {
      const option = stringField(entry, "option")
      if (option === undefined || !question.options.includes(option)) continue
      const distribution = numberRecord(entry, "distribution")
      answers[question.id] = {
        type: "choice",
        option,
        confidence: clamp01(numberField(entry, "confidence") ?? 1),
        ...(distribution !== undefined ? { distribution } : {}),
      }
      continue
    }

    const probability = numberField(entry, "probability")
    if (probability === undefined) continue
    answers[question.id] = { type: "noul", probability: clamp01(probability) }
  }

  return Object.keys(answers).length > 0 ? answers : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function numberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === "number" && Number.isFinite(field) ? field : undefined
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === "string" && field.length > 0 ? field : undefined
}

function numberRecord(value: unknown, key: string): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  if (!isRecord(field)) return undefined
  const out: Record<string, number> = {}
  for (const [name, entry] of Object.entries(field)) {
    if (typeof entry === "number" && Number.isFinite(entry)) out[name] = clamp01(entry)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}
