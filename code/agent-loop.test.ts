import { describe, expect, test } from "bun:test"
import { runAgent } from "./agent-loop"
import type {
  AgentInput,
  GuardPort,
  ModelInput,
  ModelPort,
  ModelReply,
  ToolPort,
  ToolSpec,
} from "./agent-loop-types"

const NO_GUARD: GuardPort = { observeTurn: () => ({ kind: "none" }) }

function modelOf(replies: readonly ModelReply[]): ModelPort & { calls: ModelInput[] } {
  const calls: ModelInput[] = []
  let index = 0
  return {
    calls,
    async complete(input) {
      calls.push(input)
      const reply = replies[Math.min(index, replies.length - 1)]
      index += 1
      if (!reply) throw new Error("model returned no reply")
      return reply
    },
  }
}

function reply(text: string, toolCalls: ModelReply["toolCalls"] = []): ModelReply {
  return { text, toolCalls, usage: { inTok: 10, outTok: 5 } }
}

function toolsOf(specs: readonly ToolSpec[], run: ToolPort["execute"]): ToolPort {
  return { specs, execute: run }
}

function input(overrides: Partial<AgentInput> & Pick<AgentInput, "model" | "tools">): AgentInput {
  return {
    guard: NO_GUARD,
    system: "system",
    buildPrompt: () => "prompt",
    limits: { maxTurns: 4 },
    ...overrides,
  }
}

describe("agent loop", () => {
  test("a reply with no tool calls finishes the run", async () => {
    const model = modelOf([reply("done")])
    const result = await runAgent(input({ model, tools: toolsOf([], async () => ({ name: "", ok: true, content: "" })) }))

    expect(result.stopped).toBe("done")
    expect(result.text).toBe("done")
    expect(result.turns).toBe(1)
    expect(result.history).toHaveLength(0)
    expect(result.usage).toEqual({ inTok: 10, outTok: 5 })
  })

  test("malformed arguments become a failed result and the tool is not executed", async () => {
    let executed = false
    const spec: ToolSpec = {
      name: "read_file",
      description: "read",
      validate: (args) => (typeof args.path === "string" ? undefined : "path must be a string"),
    }
    const model = modelOf([
      reply("reading", [{ name: "read_file", args: { path: 42 } }]),
      reply("stopped"),
    ])
    const tools = toolsOf([spec], async () => {
      executed = true
      return { name: "read_file", ok: true, content: "should not run" }
    })

    const result = await runAgent(input({ model, tools }))
    const first = result.history[0]?.results[0]

    expect(executed).toBe(false)
    expect(first?.ok).toBe(false)
    expect(first?.content).toContain("invalid arguments: path must be a string")
    expect(result.stopped).toBe("done")
  })

  test("a thrown tool is a failed result, not a crashed run", async () => {
    const model = modelOf([
      reply("calling", [{ name: "bash", args: { command: "" } }]),
      reply("recovered"),
    ])
    const tools = toolsOf(
      [{ name: "bash", description: "shell" }],
      async () => {
        throw new Error("empty command")
      },
    )

    const result = await runAgent(input({ model, tools }))
    const first = result.history[0]?.results[0]

    expect(first?.ok).toBe(false)
    expect(first?.content).toBe("tool error: empty command")
    expect(result.stopped).toBe("done")
  })

  test("a guard nudge is injected as a tool result the model can read", async () => {
    const guard: GuardPort = {
      observeResult: () => ({ kind: "nudge", reason: "you are repeating yourself" }),
      observeTurn: () => ({ kind: "none" }),
    }
    const model = modelOf([
      reply("again", [{ name: "read_file", args: { path: "src/main.rs" } }]),
      reply("changed course"),
    ])
    const tools = toolsOf(
      [{ name: "read_file", description: "read" }],
      async () => ({ name: "read_file", ok: true, content: "fn main() {}" }),
    )

    const result = await runAgent(input({ model, tools, guard }))
    const results = result.history[0]?.results ?? []

    expect(results).toHaveLength(2)
    expect(results[1]?.name).toBe("guard")
    expect(results[1]?.content).toContain("you are repeating yourself")
  })

  test("a guard abort stops the loop immediately", async () => {
    const guard: GuardPort = {
      observeCall: () => ({ kind: "abort", reason: "same call twelve times" }),
      observeTurn: () => ({ kind: "none" }),
    }
    const model = modelOf([reply("loop", [{ name: "read_file", args: { path: "a" } }])])
    const tools = toolsOf(
      [{ name: "read_file", description: "read" }],
      async () => ({ name: "read_file", ok: true, content: "a" }),
    )

    const result = await runAgent(input({ model, tools, guard }))

    expect(result.stopped).toBe("guard")
    expect(result.guardReason).toBe("same call twelve times")
    expect(result.turns).toBe(1)
    expect(model.calls).toHaveLength(1)
  })

  test("the deadline stops the loop before the next model call", async () => {
    const model = modelOf([reply("never")])

    const result = await runAgent(
      input({
        model,
        tools: toolsOf([], async () => ({ name: "", ok: true, content: "" })),
        limits: { maxTurns: 4, deadlineMs: 0 },
      }),
    )

    expect(result.stopped).toBe("deadline")
    expect(result.turns).toBe(0)
    expect(model.calls).toHaveLength(0)
  })

  test("the turn cap bounds a model that never stops calling tools", async () => {
    const model = modelOf([reply("again", [{ name: "read_file", args: { path: "a" } }])])
    const tools = toolsOf(
      [{ name: "read_file", description: "read" }],
      async () => ({ name: "read_file", ok: true, content: "a" }),
    )

    const result = await runAgent(input({ model, tools, limits: { maxTurns: 3 } }))

    expect(result.stopped).toBe("turn-cap")
    expect(result.turns).toBe(3)
    expect(result.history).toHaveLength(3)
    expect(model.calls).toHaveLength(3)
  })

  test("tool results are capped before they enter the next prompt", async () => {
    const model = modelOf([
      reply("read", [{ name: "read_file", args: { path: "big" } }]),
      reply("done"),
    ])
    const tools = toolsOf(
      [{ name: "read_file", description: "read" }],
      async () => ({ name: "read_file", ok: true, content: "x".repeat(50) }),
    )

    const result = await runAgent(
      input({ model, tools, limits: { maxTurns: 4, maxToolResultChars: 10 } }),
    )
    const first = result.history[0]?.results[0]

    expect(first?.content.startsWith("x".repeat(10))).toBe(true)
    expect(first?.content).toContain("[tool result truncated at 10 chars]")
  })

  test("the prompt is rebuilt from history after each turn", async () => {
    const model = modelOf([
      reply("read", [{ name: "read_file", args: { path: "a" } }]),
      reply("done"),
    ])
    const tools = toolsOf(
      [{ name: "read_file", description: "read" }],
      async () => ({ name: "read_file", ok: true, content: "a" }),
    )
    const prompts: number[] = []

    await runAgent(
      input({
        model,
        tools,
        buildPrompt: (history) => {
          prompts.push(history.length)
          return `turns=${history.length}`
        },
      }),
    )

    expect(prompts).toEqual([0, 1])
  })
})
