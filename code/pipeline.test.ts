import { describe, expect, test } from "bun:test"
import type { GuardPort, ModelInput, ModelPort, ModelReply, ToolPort } from "./agent-loop-types"
import { runPipeline } from "./pipeline"
import { contextBlock, selectContext } from "./pipeline-context"
import { parsePlan } from "./pipeline-plan"
import { buildStepPrompt } from "./pipeline-prompt"
import { BUILD_STEP, HARDEN_STEP, INTEGRATE_STEP, PLAN_STEP } from "./pipeline-steps"
import { createRunState } from "./pipeline-state"
import { allowTools } from "./pipeline-tools"
import type { GatePort, PipelineEvent, RunState, Step } from "./pipeline-types"

const NO_GUARD: GuardPort = { observeTurn: () => ({ kind: "none" }) }
const PASS_GATES: GatePort = { check: () => ({ ok: true }) }

function stateOf(overrides: Partial<RunState> = {}): RunState {
  return { ...createRunState({ task: "add 2FA", stack: "TypeScript", repoMap: "src/" }), ...overrides }
}

function reply(text: string, toolCalls: ModelReply["toolCalls"] = []): ModelReply {
  return { text, toolCalls, usage: { inTok: 10, outTok: 5 } }
}

function modelOf(replies: readonly ModelReply[]): ModelPort & { calls: ModelInput[] } {
  const calls: ModelInput[] = []
  let index = 0
  return {
    calls,
    async complete(input) {
      calls.push(input)
      const next = replies[Math.min(index, replies.length - 1)]
      index += 1
      if (!next) throw new Error("model returned no reply")
      return next
    },
  }
}

function emptyTools(): ToolPort {
  return { specs: [], execute: async (call) => ({ name: call.name, ok: true, content: "" }) }
}

function step(overrides: Partial<Step> & Pick<Step, "id" | "kind">): Step {
  return {
    tools: [],
    contextBudget: 100,
    instruction: "do the step",
    context: () => [],
    gate: overrides.id,
    ...overrides,
  }
}

describe("per-step context", () => {
  test("plan sees the task, stack and repo map; build does not see security findings", () => {
    const state = stateOf({ securityFindings: ["hard-coded secret"] })

    expect(PLAN_STEP.context(state).map((block) => block.id)).toEqual(["task", "stack", "repo-map"])
    expect(BUILD_STEP.context(state).map((block) => block.id)).not.toContain("security-0")
  })

  test("build sees one task, its files and criteria, and a gate failure", () => {
    const task = { id: "t1", title: "Add TOTP", files: ["src/auth/totp.ts"], criteria: ["rejects reused code"] }
    const state = stateOf({ currentTask: task, lastFailure: "test failed: reused code accepted" })
    const blocks = BUILD_STEP.context(state)

    expect(blocks.map((block) => block.id)).toEqual(["task", "files", "criteria", "failure", "repo-map"])
    expect(blocks.find((block) => block.id === "files")?.text).toBe("src/auth/totp.ts")
    expect(blocks.find((block) => block.id === "failure")?.text).toContain("reused code")
  })

  test("harden sees the diff, tests, plan criteria and security findings", () => {
    const state = stateOf({
      plan: { tasks: [{ id: "t1", title: "Add TOTP", files: [], criteria: ["c1", "c2"] }] },
      diff: "diff --git a/x b/x",
      testOutput: "3 pass",
      securityFindings: ["no rate limit"],
    })
    const blocks = HARDEN_STEP.context(state)

    expect(blocks.map((block) => block.id)).toEqual(["diff", "tests", "criteria", "security-0"])
    expect(blocks.find((block) => block.id === "criteria")?.text).toBe("c1\nc2")
  })

  test("the integrate step declares no context, no tools and no prompt", () => {
    expect(INTEGRATE_STEP.kind).toBe("deterministic")
    expect(INTEGRATE_STEP.tools).toEqual([])
    expect(INTEGRATE_STEP.context(stateOf())).toEqual([])
    expect(INTEGRATE_STEP.instruction).toBe("")
    expect(INTEGRATE_STEP.run).toBeUndefined()
  })
})

describe("context manifest", () => {
  test("keeps required blocks and drops optional blocks that do not fit", () => {
    const required = contextBlock({ id: "task", kind: "task", source: "input", text: "x".repeat(40), required: true })
    const first = contextBlock({ id: "first", kind: "file", source: "repo", text: "y".repeat(20) })
    const second = contextBlock({ id: "second", kind: "file", source: "repo", text: "z".repeat(40) })
    const selection = selectContext(
      step({ id: "build", kind: "model", contextBudget: 20, context: () => [required, first, second] }),
      stateOf(),
    )

    expect(selection.blocks.map((block) => block.id)).toEqual(["task", "first"])
    expect(selection.manifest.tokens).toBe(15)
    expect(selection.manifest.budget).toBe(20)
    expect(selection.manifest.overBudget).toBe(false)
    expect(selection.manifest.dropped).toEqual([{ id: "second", reason: "over budget: 10 tokens, 5 left" }])
  })

  test("required context may exceed the budget, and the manifest says so", () => {
    const required = contextBlock({ id: "task", kind: "task", source: "input", text: "x".repeat(400), required: true })
    const selection = selectContext(
      step({ id: "plan", kind: "model", contextBudget: 10, context: () => [required] }),
      stateOf(),
    )

    expect(selection.blocks).toHaveLength(1)
    expect(selection.manifest.tokens).toBe(100)
    expect(selection.manifest.overBudget).toBe(true)
    expect(selection.manifest.dropped).toEqual([])
  })

  test("the manifest records the blocks the step actually saw", () => {
    const selection = selectContext(PLAN_STEP, stateOf())
    const ids = selection.manifest.blocks.map((block) => block.id)

    expect(ids).toEqual(["task", "stack", "repo-map"])
    expect(selection.manifest.blocks.every((block) => block.required)).toBe(true)
  })
})

describe("per-step tool allowlist", () => {
  test("only the allowed specs are visible and a disallowed call fails before execution", async () => {
    let executed = false
    const registry: ToolPort = {
      specs: [
        { name: "read_file", description: "read" },
        { name: "write_file", description: "write" },
      ],
      async execute(call) {
        executed = true
        return { name: call.name, ok: true, content: "ran" }
      },
    }
    const allowed = allowTools(registry, ["read_file"])

    expect(allowed.specs.map((spec) => spec.name)).toEqual(["read_file"])

    const result = await allowed.execute({ name: "write_file", args: { path: "x" } })

    expect(executed).toBe(false)
    expect(result.ok).toBe(false)
    expect(result.content).toContain('tool "write_file" is not allowed for this step')
  })

  test("the model only sees the step's tools, and an invented tool call is a failed result", async () => {
    const model = modelOf([
      reply("writing", [{ name: "write_file", args: { path: "x" } }]),
      reply("done"),
    ])
    const registry: ToolPort = {
      specs: [
        { name: "read_file", description: "read" },
        { name: "write_file", description: "write" },
      ],
      async execute(call) {
        return { name: call.name, ok: true, content: "ran" }
      },
    }
    const result = await runPipeline({
      model,
      tools: registry,
      guard: NO_GUARD,
      gates: PASS_GATES,
      state: stateOf(),
      steps: [step({ id: "plan", kind: "model", tools: ["read_file"], parse: (text) => text })],
    })

    expect(result.ok).toBe(true)
    expect(model.calls[0]?.tools.map((spec) => spec.name)).toEqual(["read_file"])
    expect(result.steps[0]?.agent?.history[0]?.results[0]?.content).toContain("is not allowed for this step")
  })
})

describe("plan parsing", () => {
  test("accepts fenced JSON and keeps the declared files and criteria", () => {
    const plan = parsePlan(
      '```json\n{"tasks":[{"id":"t1","title":"Add TOTP","files":["src/totp.ts"],"criteria":["works"]}]}\n```',
    )

    expect(plan.tasks).toEqual([
      { id: "t1", title: "Add TOTP", files: ["src/totp.ts"], criteria: ["works"] },
    ])
  })

  test("fails closed when a task is missing criteria", () => {
    expect(() => parsePlan('{"tasks":[{"id":"t1","title":"x","files":[]}]}')).toThrow(
      "plan: task 0 needs criteria: string[]",
    )
    expect(() => parsePlan("not json")).toThrow("plan is not valid JSON")
    expect(() => parsePlan('{"tasks":[]}')).toThrow("at least one task is required")
  })
})

describe("pipeline runner", () => {
  test("a model step runs the loop, parses the artifact and advances to a deterministic step", async () => {
    const model = modelOf([reply("artifact")])
    const events: PipelineEvent[] = []
    let integrated = false
    const steps: Step[] = [
      step({ id: "plan", kind: "model", tools: ["read_file"], parse: (text) => ({ text }) }),
      step({
        id: "integrate",
        kind: "deterministic",
        run: async () => {
          integrated = true
          return { landed: true }
        },
      }),
    ]

    const result = await runPipeline({
      model,
      tools: emptyTools(),
      guard: NO_GUARD,
      gates: PASS_GATES,
      state: stateOf(),
      steps,
      onEvent: (event) => events.push(event),
    })

    expect(result.ok).toBe(true)
    expect(model.calls).toHaveLength(1)
    expect(integrated).toBe(true)
    expect(result.state.artifacts.plan).toEqual({ text: "artifact" })
    expect(result.state.artifacts.integrate).toEqual({ landed: true })
    expect(events.map((event) => `${event.type}:${event.step}`)).toEqual([
      "step.start:plan",
      "step.end:plan",
      "step.start:integrate",
      "step.end:integrate",
    ])
  })

  test("a parse failure stops the pipeline and records the reason", async () => {
    const model = modelOf([reply("not json")])

    const result = await runPipeline({
      model,
      tools: emptyTools(),
      guard: NO_GUARD,
      gates: PASS_GATES,
      state: stateOf(),
      steps: [step({ id: "plan", kind: "model", parse: parsePlan })],
    })

    expect(result.ok).toBe(false)
    expect(result.failedAt).toBe("plan")
    expect(result.gate?.reason).toContain("output did not parse")
    expect(result.state.failures[0]?.step).toBe("plan")
    expect(result.state.artifacts.plan).toBeUndefined()
  })

  test("a failed gate stops the pipeline before the next step", async () => {
    const model = modelOf([reply("artifact")])
    const gates: GatePort = {
      check: (id) => (id === "build" ? { ok: false, reason: "tests failed" } : { ok: true }),
    }
    let hardened = false

    const result = await runPipeline({
      model,
      tools: emptyTools(),
      guard: NO_GUARD,
      gates,
      state: stateOf(),
      steps: [
        step({ id: "build", kind: "model", parse: (text) => text }),
        step({
          id: "harden",
          kind: "model",
          run: undefined,
          context: () => [],
          parse: (text) => {
            hardened = true
            return text
          },
        }),
      ],
    })

    expect(result.ok).toBe(false)
    expect(result.failedAt).toBe("build")
    expect(result.gate).toEqual({ ok: false, reason: "tests failed" })
    expect(result.state.artifacts.build).toBeUndefined()
    expect(hardened).toBe(false)
    expect(model.calls).toHaveLength(1)
  })

  test("the integrate declaration refuses to execute without a landing runner", async () => {
    await expect(
      runPipeline({
        model: modelOf([reply("unused")]),
        tools: emptyTools(),
        guard: NO_GUARD,
        gates: PASS_GATES,
        state: stateOf(),
        steps: [INTEGRATE_STEP],
      }),
    ).rejects.toThrow('step "integrate": deterministic runner is not included in the public slice')
  })
})

describe("state handoff", () => {
  test("the plan advances to the coder and the build gate records what the hardener reads", async () => {
    const plan = JSON.stringify({
      tasks: [
        {
          id: "t1",
          title: "Add TOTP",
          files: ["src/auth/totp.ts"],
          criteria: ["rejects reused code"],
        },
      ],
    })
    const model = modelOf([reply(plan), reply("build report"), reply("harden report")])
    const gates: GatePort = {
      check(id, _artifact, state) {
        if (id === "build") {
          state.diff = "diff --git a/src/auth/totp.ts b/src/auth/totp.ts"
          state.testOutput = "3 pass, 0 fail"
        }
        return { ok: true }
      },
    }

    const result = await runPipeline({
      model,
      tools: emptyTools(),
      guard: NO_GUARD,
      gates,
      state: stateOf(),
      steps: [PLAN_STEP, BUILD_STEP, HARDEN_STEP],
    })

    expect(result.ok).toBe(true)
    expect(result.state.plan?.tasks[0]?.id).toBe("t1")
    expect(result.state.currentTask?.id).toBe("t1")
    expect(model.calls[1]?.prompt).toContain("t1: Add TOTP")
    expect(model.calls[1]?.prompt).toContain("src/auth/totp.ts")
    expect(model.calls[1]?.prompt).toContain("rejects reused code")
    expect(model.calls[2]?.prompt).toContain("diff --git a/src/auth/totp.ts")
    expect(model.calls[2]?.prompt).toContain("3 pass, 0 fail")
  })

  test("a model error is recorded instead of escaping the pipeline", async () => {
    const model: ModelPort = {
      complete: async () => {
        throw new Error("provider down")
      },
    }

    const result = await runPipeline({
      model,
      tools: emptyTools(),
      guard: NO_GUARD,
      gates: PASS_GATES,
      state: stateOf(),
      steps: [PLAN_STEP],
    })

    expect(result.ok).toBe(false)
    expect(result.failedAt).toBe("plan")
    expect(result.gate?.reason).toBe("agent error: provider down")
    expect(result.state.failures[0]?.reason).toBe("agent error: provider down")
  })

  test("a gate error is recorded instead of escaping the pipeline", async () => {
    const gates: GatePort = {
      check: () => {
        throw new Error("runner crashed")
      },
    }

    const result = await runPipeline({
      model: modelOf([reply("unused")]),
      tools: emptyTools(),
      guard: NO_GUARD,
      gates,
      state: stateOf(),
      steps: [step({ id: "plan", kind: "model" })],
    })

    expect(result.ok).toBe(false)
    expect(result.failedAt).toBe("plan")
    expect(result.gate?.reason).toBe("gate error: runner crashed")
  })
})

describe("default pipeline", () => {
  test("runs env, plan, build and harden without an explicit step list", async () => {
    const plan = JSON.stringify({
      tasks: [
        {
          id: "t1",
          title: "Add TOTP",
          files: ["src/auth/totp.ts"],
          criteria: ["rejects reused code"],
        },
      ],
    })
    const model = modelOf([reply(plan), reply("build report"), reply("harden report")])
    const result = await runPipeline({
      model,
      tools: emptyTools(),
      guard: NO_GUARD,
      gates: PASS_GATES,
      state: stateOf(),
    })

    expect(result.ok).toBe(true)
    expect(result.steps.map((entry) => entry.step)).toEqual(["env", "plan", "build", "harden"])
    // The deterministic env step runs before the model: one call per model step.
    expect(model.calls).toHaveLength(3)
    expect(result.steps[0]?.artifact).toEqual({ baseline: "pass" })
  })
})

describe("prompt rendering", () => {
  test("the prompt includes previous tool calls and their results", () => {
    const prompt = buildStepPrompt(
      [
        contextBlock({
          id: "task",
          kind: "task",
          source: "input",
          text: "add 2FA",
          required: true,
        }),
      ],
      [
        {
          assistant: "reading",
          toolCalls: [{ name: "read_file", args: { path: "a.ts" } }],
          results: [{ name: "read_file", ok: true, content: "export {}" }],
        },
      ],
    )

    expect(prompt).toContain("[task:input]")
    expect(prompt).toContain("CALL read_file")
    expect(prompt).toContain('"path":"a.ts"')
    expect(prompt).toContain("TOOL read_file (ok)")
  })
})
