/**
 * The pipeline vocabulary.
 *
 * A step declares what it may see, what tools it may use and which gate decides
 * whether its artifact advances. The runner, the step table, the context
 * selector and the tool policy are separate files; these are the shapes they
 * share.
 */

import type { AgentResult, GuardPort, ModelPort, ToolPort } from "./agent-loop-types"

export type StepId = "env" | "plan" | "build" | "harden" | "integrate"
export type StepKind = "model" | "deterministic"

export type ContextKind =
  | "task"
  | "plan"
  | "file"
  | "diff"
  | "test"
  | "security"
  | "failure"
  | "map"
  | "artifact"

/** One block about to be shown to a step. */
export interface ContextBlock {
  id: string
  kind: ContextKind
  source: string
  text: string
  /** Required blocks survive the budget; optional blocks may be dropped. */
  required: boolean
  tokens: number
}

export interface ContextManifestBlock {
  id: string
  kind: ContextKind
  source: string
  tokens: number
  required: boolean
}

export interface DroppedContextBlock {
  id: string
  reason: string
}

/** What the step actually saw, without the full text of every block. */
export interface ContextManifest {
  step: StepId
  blocks: readonly ContextManifestBlock[]
  tokens: number
  budget: number
  overBudget: boolean
  dropped: readonly DroppedContextBlock[]
}

export interface ContextSelection {
  blocks: ContextBlock[]
  manifest: ContextManifest
}

export interface GateResult {
  ok: boolean
  reason?: string
}

/**
 * The real build, test, security and landing checks stay behind this port.
 *
 * A gate may also record what it observed on the workspace (the diff, the test
 * output, security findings) on the state. The next step reads those fields as
 * context, which is how the build-to-harden handoff is made without copying a
 * transcript.
 */
export interface GatePort {
  check(gate: StepId, artifact: unknown, state: RunState): Promise<GateResult> | GateResult
}

export interface PlanTask {
  id: string
  title: string
  files: readonly string[]
  criteria: readonly string[]
}

export interface Plan {
  tasks: readonly PlanTask[]
}

export interface StepFailure {
  step: StepId
  reason: string
}

export interface RunState {
  task: string
  stack: string
  repoMap: string
  plan?: Plan
  currentTask?: PlanTask
  diff?: string
  testOutput?: string
  securityFindings?: readonly string[]
  lastFailure?: string
  artifacts: Partial<Record<StepId, unknown>>
  failures: StepFailure[]
}

export interface Step {
  id: StepId
  kind: StepKind
  /** The only tools this step may see or execute. */
  tools: readonly string[]
  contextBudget: number
  /** Instructions are separate from context; they are not a persona. */
  instruction: string
  context: (state: RunState) => ContextBlock[]
  parse?: (text: string) => unknown
  /** Gate name. The public slice uses the step id; the engine can name a gate independently. */
  gate: StepId
  /**
   * State transition after the gate passes. The runner calls it; the step
   * decides which artifact fields the next step may read.
   */
  apply?: (state: RunState, artifact: unknown) => void
  run?: (state: RunState) => Promise<unknown>
  maxTurns?: number
  deadlineMs?: number
}

export type PipelineEvent =
  | { type: "step.start"; step: StepId; manifest: ContextManifest }
  | { type: "step.end"; step: StepId; manifest: ContextManifest; gate: GateResult }

export interface StepResult {
  step: StepId
  artifact: unknown
  manifest: ContextManifest
  gate: GateResult
  agent?: AgentResult
}

export interface PipelineResult {
  ok: boolean
  steps: StepResult[]
  state: RunState
  failedAt?: StepId
  gate?: GateResult
}

export interface PipelineOptions {
  model: ModelPort
  tools: ToolPort
  guard: GuardPort
  gates: GatePort
  state: RunState
  steps?: readonly Step[]
  signal?: AbortSignal
  onEvent?: (event: PipelineEvent) => void
}
