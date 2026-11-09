import { describe, expect, test } from "bun:test"
import { LoopGuard, commandFamily, resultSignature } from "./loop-guards"

describe("command family", () => {
  test("collapses flags, paths and shell prefixes", () => {
    expect(commandFamily("cd /w && cargo test --offline 2>&1 | tail -40")).toBe("cargo test+tail")
    expect(commandFamily("cargo test | tail -45")).toBe("cargo test+tail")
    expect(commandFamily("CARGO_TEST=1 cargo test")).toBe("cargo test")
  })
})

describe("loop guard", () => {
  test("distinguishes long results that share a prefix", () => {
    const prefix = "x".repeat(400)
    const a = resultSignature({ ok: true, content: `${prefix}A` })
    const b = resultSignature({ ok: true, content: `${prefix}B` })

    expect(a).not.toBe(b)
  })

  test("nudges at four identical calls and aborts after the same result repeats", () => {
    const guard = new LoopGuard()
    const call = { name: "read_file", args: { path: "src/main.rs" } }
    const result = { ok: true, content: "fn main() {}" }

    expect(guard.observeCall(call).kind).toBe("none")
    expect(guard.observeCall(call).kind).toBe("none")
    expect(guard.observeCall(call).kind).toBe("none")
    expect(guard.observeCall(call).kind).toBe("nudge")

    for (let index = 0; index < 9; index++) guard.observeCall(call)
    expect(guard.observeResult(call, result).kind).toBe("none")
    expect(guard.observeResult(call, result).kind).toBe("abort")
  })

  test("sees the same command through different flags and pipes", () => {
    const guard = new LoopGuard()
    for (let index = 0; index < 4; index++) {
      expect(
        guard.observeCall({
          name: "run_command",
          args: { command: `cargo test --flag-${index} | tail -${index}` },
        }).kind,
      ).toBe("none")
    }
    const action = guard.observeCall({
      name: "run_command",
      args: { command: "cd /w && cargo test --offline | tail -40" },
    })
    expect(action.kind).toBe("nudge")

    const abortGuard = new LoopGuard()
    const result = { ok: true, content: "test result: ok" }
    for (let index = 0; index < 13; index++) {
      abortGuard.observeCall({ name: "run_command", args: { command: `cargo test --x-${index}` } })
    }
    expect(
      abortGuard.observeResult({ name: "run_command", args: { command: "cargo test --last" } }, result).kind,
    ).toBe("none")
    expect(
      abortGuard.observeResult({ name: "run_command", args: { command: "cargo test --last-again" } }, result).kind,
    ).toBe("abort")
  })

  test("nudges then aborts when every call fails and nothing is written", () => {
    const guard = new LoopGuard()
    const failure = { ok: false, content: "ENOENT" }

    expect(guard.observeTurn({ results: [failure], wroteSomething: false }).kind).toBe("none")
    expect(guard.observeTurn({ results: [failure], wroteSomething: false }).kind).toBe("nudge")

    for (let index = 0; index < 3; index++) {
      expect(guard.observeTurn({ results: [failure], wroteSomething: false }).kind).toBe("none")
    }
    expect(guard.observeTurn({ results: [failure], wroteSomething: false }).kind).toBe("abort")
  })

  test("nudges on the third rewrite and aborts on the sixth", () => {
    const guard = new LoopGuard()
    const call = { name: "write_file", args: { path: "src/main.rs" } }
    const result = { ok: true, content: "wrote src/main.rs" }

    expect(guard.observeResult(call, result).kind).toBe("none")
    expect(guard.observeResult(call, result).kind).toBe("none")
    expect(guard.observeResult(call, result).kind).toBe("nudge")
    expect(guard.observeResult(call, result).kind).toBe("none")
    expect(guard.observeResult(call, result).kind).toBe("none")
    expect(guard.observeResult(call, result).kind).toBe("abort")
  })
})
