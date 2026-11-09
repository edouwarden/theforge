/**
 * Loop-guard slice, extracted from the private agent runner.
 *
 * One LLM<->tool loop is easy to write and hard to keep bounded. These are the
 * deterministic checks that sit between the model and the tools:
 *
 *   - the same call with the same arguments, returning the same result
 *   - the same shell command in a different shape
 *   - a turn where every call failed and nothing was written
 *   - the same file rewritten over and over
 *
 * A guard nudges first. It aborts only when the model has had a chance to
 * change course. The thresholds are published because they are part of the
 * control logic, not part of the prompt.
 */

/** The tool boundary this guard observes. Kept local so the guard is standalone. */
interface ToolCall {
  name: string
  args?: Record<string, unknown>
}

interface ToolResult {
  ok: boolean
  content: string
}

export const REPEAT_NUDGE_AFTER = 4
export const REPEAT_ABORT_AFTER = 12
export const FAMILY_NUDGE_AFTER = 5
export const FAMILY_ABORT_AFTER = 12
export const UNPROGRESSIVE_NUDGE_AFTER = 2
export const MAX_UNPROGRESSIVE_TURNS = 6
export const FILE_REWRITE_NUDGE_AFTER = 3
export const FILE_REWRITE_ABORT_AFTER = 5

const WRITE_TOOLS = new Set(["write_file", "patch_file", "write_batch", "patch_batch"])

export type GuardAction =
  | { kind: "none" }
  | { kind: "nudge"; reason: string }
  | { kind: "abort"; reason: string }

const NONE: GuardAction = { kind: "none" }

/**
 * The shape of a shell command: programs with flags, paths, shell prefixes and
 * redirections removed. `cd /w && cargo test --offline 2>&1 | tail -40` and
 * `cargo test | tail -45` both reduce to `cargo test+tail`.
 */
export function commandFamily(command: string): string {
  const segments = command
    .toLowerCase()
    .split(/;|\|\||&&|\n|\|/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)

  const out: string[] = []
  for (const segment of segments) {
    const tokens = segment
      .split(/\s+/)
      .map((token) => token.replace(/^["']|["']$/g, ""))
      .filter((token) => token.length > 0)

    const words: string[] = []
    for (const token of tokens) {
      if (
        ["cd", "env", "export", "set", "sudo", "nohup", "timeout", "then", "do", "else", "fi", "{"].includes(
          token,
        )
      ) {
        continue
      }
      if (token.startsWith("-") || token.includes(">") || token.includes("<") || token.includes("&")) continue
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue
      if (token.startsWith("/") || token.startsWith(".") || token.startsWith("~") || token.startsWith("$")) continue
      words.push(token)
      if (words.length === 2) break
    }

    if (words.length > 0) out.push(words.join(" "))
    if (out.length === 2) break
  }

  return out.join("+")
}

/** Two identical signatures mean the same question got the same answer twice. */
export function resultSignature(result: ToolResult): string {
  const content = typeof result.content === "string" ? result.content : ""
  const head = content.slice(0, 200)
  const tail = content.length > 200 ? content.slice(-200) : ""
  return `${result.ok ? "ok" : "err"}:${content.length}:${head}:${tail}`
}

function callKey(call: ToolCall): string {
  return `${call.name}:${JSON.stringify(call.args ?? {})}`
}

function pathOf(call: ToolCall): string | undefined {
  const path = call.args?.path
  return typeof path === "string" ? path : undefined
}

/**
 * Stateful guard for one agent run. Call `observeCall` before executing a call,
 * `observeResult` after it returns, and `observeTurn` once per completed turn.
 */
export class LoopGuard {
  private readonly callCounts = new Map<string, number>()
  private readonly familyCounts = new Map<string, number>()
  private readonly fileWriteCounts = new Map<string, number>()
  private readonly lastCallSignature = new Map<string, string>()
  private readonly lastFamilySignature = new Map<string, string>()
  private readonly nudgedCalls = new Set<string>()
  private readonly nudgedFamilies = new Set<string>()
  private readonly nudgedFiles = new Set<string>()
  private unprogressedTurns = 0

  observeCall(call: ToolCall): GuardAction {
    const key = callKey(call)
    const count = (this.callCounts.get(key) ?? 0) + 1
    this.callCounts.set(key, count)

    if (count >= REPEAT_NUDGE_AFTER && !this.nudgedCalls.has(key)) {
      this.nudgedCalls.add(key)
      return {
        kind: "nudge",
        reason: `the same ${call.name} call has already run ${count} times`,
      }
    }

    const command = typeof call.args?.command === "string" ? call.args.command : ""
    if (command.length > 0) {
      const family = `${call.name}:${commandFamily(command)}`
      const familyCount = (this.familyCounts.get(family) ?? 0) + 1
      this.familyCounts.set(family, familyCount)
      if (familyCount >= FAMILY_NUDGE_AFTER && !this.nudgedFamilies.has(family)) {
        this.nudgedFamilies.add(family)
        return {
          kind: "nudge",
          reason: `the command "${commandFamily(command)}" has already run ${familyCount} times`,
        }
      }
    }

    return NONE
  }

  observeResult(call: ToolCall, result: ToolResult): GuardAction {
    const key = callKey(call)
    const signature = resultSignature(result)

    if ((this.callCounts.get(key) ?? 0) > REPEAT_ABORT_AFTER) {
      const previous = this.lastCallSignature.get(key)
      this.lastCallSignature.set(key, signature)
      if (previous !== undefined && previous === signature) {
        return {
          kind: "abort",
          reason: `the same ${call.name} call repeated with the same result`,
        }
      }
    }

    const command = typeof call.args?.command === "string" ? call.args.command : ""
    if (command.length > 0) {
      const family = `${call.name}:${commandFamily(command)}`
      if ((this.familyCounts.get(family) ?? 0) > FAMILY_ABORT_AFTER) {
        const previous = this.lastFamilySignature.get(family)
        this.lastFamilySignature.set(family, signature)
        if (previous !== undefined && previous === signature) {
          return {
            kind: "abort",
            reason: `the command "${commandFamily(command)}" repeated with the same result`,
          }
        }
      }
    }

    if (result.ok && WRITE_TOOLS.has(call.name)) {
      const path = pathOf(call)
      if (path) {
        const count = (this.fileWriteCounts.get(path) ?? 0) + 1
        this.fileWriteCounts.set(path, count)
        if (count === FILE_REWRITE_NUDGE_AFTER && !this.nudgedFiles.has(path)) {
          this.nudgedFiles.add(path)
          return { kind: "nudge", reason: `the file "${path}" has been rewritten ${count} times` }
        }
        if (count > FILE_REWRITE_ABORT_AFTER) {
          return { kind: "abort", reason: `the file "${path}" was rewritten ${count} times` }
        }
      }
    }

    return NONE
  }

  observeTurn(input: { results: readonly ToolResult[]; wroteSomething: boolean }): GuardAction {
    const anyFailed = input.results.some((result) => !result.ok)
    const anySucceeded = input.results.some((result) => result.ok)

    if (input.results.length > 0 && anyFailed && !anySucceeded && !input.wroteSomething) {
      this.unprogressedTurns += 1
    } else {
      this.unprogressedTurns = 0
    }

    if (this.unprogressedTurns >= MAX_UNPROGRESSIVE_TURNS) {
      return {
        kind: "abort",
        reason: `no progress for ${this.unprogressedTurns} turns: every call failed and nothing was written`,
      }
    }
    if (this.unprogressedTurns === UNPROGRESSIVE_NUDGE_AFTER) {
      return {
        kind: "nudge",
        reason: "the last turns made no progress: every call failed and nothing was written",
      }
    }
    return NONE
  }
}
