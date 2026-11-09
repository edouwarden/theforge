/**
 * The questions JEV may answer and the shapes it returns.
 *
 * JEV is a sidecar, not a step and not a detector. These types keep its
 * vocabulary small: score a block, choose among known options, or estimate a
 * probability. It cannot invent a step or override a gate.
 */

export type JevQuestion =
  | {
      id: string
      type: "score"
      instructions: string
      criteria?: Record<string, string>
    }
  | {
      id: string
      type: "choice"
      instructions: string
      options: readonly string[]
    }
  | {
      id: string
      type: "noul"
      instructions: string
    }

export interface JevScoreAnswer {
  type: "score"
  value: number
  confidence: number
}

export interface JevChoiceAnswer {
  type: "choice"
  option: string
  confidence: number
  distribution?: Record<string, number>
}

export interface JevNoulAnswer {
  type: "noul"
  probability: number
}

export type JevAnswer = JevScoreAnswer | JevChoiceAnswer | JevNoulAnswer
export type JevAnswers = Record<string, JevAnswer>

export interface JevPort {
  /** Return the raw provider payload; `askJev` validates it. */
  ask(
    questions: readonly JevQuestion[],
    state: string,
    opts: { signal: AbortSignal },
  ): Promise<unknown>
}
