import { describe, expect, test } from "bun:test"
import {
  askJev,
  batchQuestions,
  readChoice,
  readNoul,
  readScore,
} from "./jev"
import { parseJevAnswers } from "./jev-parse"
import type { JevPort, JevQuestion } from "./jev-types"

const scoreQuestion: JevQuestion = {
  id: "importance",
  type: "score",
  instructions: "How important is this block?",
}

const choiceQuestion: JevQuestion = {
  id: "next",
  type: "choice",
  instructions: "Which path?",
  options: ["repair", "stop"],
}

const noulQuestion: JevQuestion = {
  id: "loop",
  type: "noul",
  instructions: "Is the model looping?",
}

function portOf(raw: unknown): JevPort {
  return { ask: async () => raw }
}

describe("JEV parsing", () => {
  test("reads a score and clamps it to 0..1", () => {
    const answers = parseJevAnswers(
      { importance: { value: 1.7, confidence: 0.9 } },
      [scoreQuestion],
    )

    expect(readScore(answers, "importance")).toBe(1)
    expect(answers?.importance).toEqual({ type: "score", value: 1, confidence: 0.9 })
  })

  test("reads a choice and a noul probability", () => {
    const answers = parseJevAnswers(
      {
        next: { option: "repair", confidence: 0.8 },
        loop: { probability: 0.25 },
      },
      [choiceQuestion, noulQuestion],
    )

    expect(readChoice(answers, "next")).toBe("repair")
    expect(readNoul(answers, "loop")).toBe(0.25)
  })

  test("ignores a choice that is not one of the offered options", () => {
    const answers = parseJevAnswers(
      { next: { option: "invented", confidence: 1 } },
      [choiceQuestion],
    )

    expect(answers).toBeNull()
  })

  test("a low-confidence choice falls back to the deterministic path", () => {
    const answers = parseJevAnswers(
      { next: { option: "repair", confidence: 0.3 } },
      [choiceQuestion],
    )

    expect(readChoice(answers, "next")).toBeUndefined()
    expect(readChoice(answers, "next", 0.2)).toBe("repair")
  })

  test("a malformed payload is null rather than a partial answer", async () => {
    expect(parseJevAnswers(null, [scoreQuestion])).toBeNull()
    expect(parseJevAnswers("not an object", [scoreQuestion])).toBeNull()
    expect(parseJevAnswers({ importance: { value: "high" } }, [scoreQuestion])).toBeNull()
    expect(await askJev(portOf("nope"), [scoreQuestion], "state")).toBeNull()
  })

  test("unknown questions are ignored but known answers survive", () => {
    const answers = parseJevAnswers(
      { importance: { value: 0.5 }, unknown: { value: 1 } },
      [scoreQuestion],
    )

    expect(Object.keys(answers ?? {})).toEqual(["importance"])
  })
})

describe("JEV fallback", () => {
  test("a timeout returns null and aborts the request", async () => {
    let aborted = false
    const port: JevPort = {
      ask: (_questions, _state, opts) =>
        new Promise(() => {
          opts.signal.addEventListener("abort", () => {
            aborted = true
          })
        }),
    }

    const answers = await askJev(port, [scoreQuestion], "state", { timeoutMs: 10 })

    expect(answers).toBeNull()
    expect(aborted).toBe(true)
  })

  test("a thrown provider error returns null", async () => {
    const port: JevPort = {
      ask: async () => {
        throw new Error("provider down")
      },
    }

    expect(await askJev(port, [scoreQuestion], "state")).toBeNull()
  })

  test("no port or no questions returns null without a call", async () => {
    let called = false
    const port: JevPort = {
      ask: async () => {
        called = true
        return { importance: { value: 1 } }
      },
    }

    expect(await askJev(undefined, [scoreQuestion], "state")).toBeNull()
    expect(await askJev(port, [], "state")).toBeNull()
    expect(called).toBe(false)
  })
})

describe("JEV batching", () => {
  test("splits questions into provider-sized batches and preserves order", () => {
    const questions: JevQuestion[] = Array.from({ length: 14 }, (_, index) => ({
      id: `q${index}`,
      type: "score",
      instructions: "score",
    }))

    const batches = batchQuestions(questions)

    expect(batches.map((batch) => batch.length)).toEqual([6, 6, 2])
    expect(batches.flat().map((question) => question.id)).toEqual(
      questions.map((question) => question.id),
    )
  })

  test("a batch size of one is allowed", () => {
    const questions: JevQuestion[] = [scoreQuestion, noulQuestion]

    expect(batchQuestions(questions, 1).map((batch) => batch.length)).toEqual([1, 1])
  })

  test("a non-positive batch size is treated as one instead of looping forever", () => {
    const questions: JevQuestion[] = [scoreQuestion, noulQuestion]

    expect(batchQuestions(questions, 0).map((batch) => batch.length)).toEqual([1, 1])
  })
})
