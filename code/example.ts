/**
 * A runnable example of the public slice.
 *
 * It wires fake ports so the pipeline runs without a provider, a workspace or
 * the private engine. Run it with `bun run example`.
 *
 * The plan is applied to the state after the plan gate passes. The build gate
 * records the diff and the test output. The hardener's prompt is built from
 * those fields, not from a transcript.
 */

import type { GuardPort, ModelPort, ModelReply, ToolPort } from "./agent-loop-types"
import { runPipeline } from "./pipeline"
import { createRunState } from "./pipeline-state"
import type { GatePort, PipelineEvent } from "./pipeline-types"

const PLAN = JSON.stringify({
  tasks: [
    {
      id: "t1",
      title: "Add TOTP verification",
      files: ["src/auth/totp.ts"],
      criteria: ["rejects a reused code", "accepts a fresh code"],
    },
  ],
})

function model(): ModelPort {
  const replies: ModelReply[] = [
    { text: PLAN, toolCalls: [], usage: { inTok: 0, outTok: 0 } },
    {
      text: "Writing the verifier.",
      toolCalls: [
        {
          name: "write_file",
          args: { path: "src/auth/totp.ts", content: "export function verify() {}" },
        },
      ],
      usage: { inTok: 0, outTok: 0 },
    },
    {
      text: "Implemented TOTP verification and ran the tests.",
      toolCalls: [],
      usage: { inTok: 0, outTok: 0 },
    },
    {
      text: "Extracted the verifier and kept the public API unchanged.",
      toolCalls: [],
      usage: { inTok: 0, outTok: 0 },
    },
  ]
  let index = 0
  return {
    async complete() {
      const reply = replies[index]
      index += 1
      if (reply === undefined) throw new Error("example model ran out of replies")
      return reply
    },
  }
}

const tools: ToolPort = {
  specs: [
    { name: "read_file", description: "Read a file" },
    { name: "write_file", description: "Write a file", writes: true },
    { name: "run_tests", description: "Run the test suite" },
  ],
  async execute(call) {
    console.log(`  tool: ${call.name}`)
    return { name: call.name, ok: true, content: `${call.name} ok` }
  },
}

const guard: GuardPort = {
  observeTurn: () => ({ kind: "none" }),
}

const gates: GatePort = {
  check(gate, _artifact, state) {
    if (gate === "build") {
      state.diff = "diff --git a/src/auth/totp.ts b/src/auth/totp.ts"
      state.testOutput = "3 pass, 0 fail"
    }
    return { ok: true }
  },
}

function printEvent(event: PipelineEvent): void {
  if (event.type === "step.start") {
    const blocks = event.manifest.blocks.map((block) => block.id).join(", ")
    console.log(`\n${event.step.toUpperCase()} sees: ${blocks.length > 0 ? blocks : "(deterministic)"}`)
    return
  }
  console.log(`${event.step.toUpperCase()} gate: ${event.gate.ok ? "pass" : event.gate.reason}`)
}

const result = await runPipeline({
  model: model(),
  tools,
  guard,
  gates,
  state: createRunState({
    task: "Add TOTP verification to the auth panel",
    stack: "TypeScript, Bun, SQLite",
    repoMap: "src/auth/\n  panel.ts\n  session.ts",
  }),
  onEvent: printEvent,
})

console.log(`\npipeline: ${result.ok ? "ok" : `failed at ${result.failedAt}`}`)
console.log(`plan task: ${result.state.currentTask?.title ?? "none"}`)
console.log(`diff recorded: ${result.state.diff !== undefined}`)
console.log(`tests recorded: ${result.state.testOutput !== undefined}`)
