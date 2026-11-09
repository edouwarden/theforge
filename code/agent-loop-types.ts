/**
 * The ports and data shapes used by the agent loop.
 *
 * These are declarations only. The loop, the tool boundary and the guard live
 * in their own files so each can be read without the others' implementation.
 */

export interface ToolCall {
  id?: string
  name: string
  args?: Record<string, unknown>
}

export interface ToolResult {
  name: string
  ok: boolean
  content: string
}

export interface ToolSpec {
  name: string
  description: string
  parameters?: Record<string, unknown>
  /** True when a successful call changes the workspace. */
  writes?: boolean
  /** Optional local argument check. Return a reason to reject the call. */
  validate?: (args: Record<string, unknown>) => string | undefined
}

export interface ToolPort {
  readonly specs: readonly ToolSpec[]
  execute(call: ToolCall): Promise<ToolResult>
}

export interface ModelInput {
  system: string
  prompt: string
  tools: readonly ToolSpec[]
  temperature: number
  thinking?: boolean
  signal?: AbortSignal
}

export interface ModelReply {
  text: string
  toolCalls: readonly ToolCall[]
  usage: { inTok: number; outTok: number }
}

export interface ModelPort {
  complete(input: ModelInput): Promise<ModelReply>
}

export type GuardAction =
  | { kind: "none" }
  | { kind: "nudge"; reason: string }
  | { kind: "abort"; reason: string }

/**
 * The loop only needs the observations. A guard may nudge first and abort
 * later; the loop injects a nudge as a tool result so the model actually reads
 * it.
 */
export interface GuardPort {
  observeCall?(call: ToolCall): GuardAction
  observeResult?(call: ToolCall, result: ToolResult): GuardAction
  observeTurn(input: { results: readonly ToolResult[]; wroteSomething: boolean }): GuardAction
}

export interface TurnRecord {
  assistant: string
  toolCalls: readonly ToolCall[]
  results: readonly ToolResult[]
}

export interface AgentLimits {
  maxTurns: number
  deadlineMs?: number
  /** Tool results are capped before they enter the next prompt. */
  maxToolResultChars?: number
}

export interface AgentInput {
  model: ModelPort
  tools: ToolPort
  guard: GuardPort
  system: string
  buildPrompt: (history: readonly TurnRecord[]) => string
  limits: AgentLimits
  temperature?: number
  thinking?: boolean
  signal?: AbortSignal
}

export type AgentStop = "done" | "guard" | "turn-cap" | "deadline"

export interface AgentResult {
  text: string
  turns: number
  usage: { inTok: number; outTok: number }
  stopped: AgentStop
  history: readonly TurnRecord[]
  guardReason?: string
}
