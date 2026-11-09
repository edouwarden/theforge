/**
 * The declared pipeline steps.
 *
 * This table is the contract: each step says what context it may see, which
 * tools it may use, how its output parses and which gate decides whether its
 * artifact advances. The runner does not add context or tools on its own.
 *
 *   step        kind           context it receives                         produces
 *   env         deterministic  none                                        baseline result
 *   plan        model          task, stack, repo map                       Plan
 *   build       model loop     one task, files, criteria, last failure     report
 *   harden      model          diff, tests, plan criteria, findings        refactor + audit
 *   integrate   deterministic  none in this declaration                    landed or reverted
 *
 * The runner applies a passing plan to `state.plan` and `state.currentTask`, so
 * the coder sees one task rather than the whole plan. The build gate records
 * the workspace diff and test output on the state, so the hardener sees what
 * changed and what passed. The hardener's artifact is what the private landing
 * tool would validate and merge.
 *
 * This is a reduced demo pipeline, not the full step table: the major stages
 * plus one deterministic stage, enough to show the model/deterministic split.
 */

import { contextBlock } from "./pipeline-context"
import { parsePlan } from "./pipeline-plan"
import { applyPlan } from "./pipeline-state"
import type { Step } from "./pipeline-types"

/**
 * Step 0. Deterministic: prepare the workspace and check the untouched
 * baseline before the model sees the tree. The demo runner is a stand-in for
 * the real workspace tooling, which stays private.
 */
export const ENV_STEP: Step = {
  id: "env",
  kind: "deterministic",
  tools: [],
  contextBudget: 0,
  instruction: "",
  context: () => [],
  run: async (state) => {
    state.testOutput = "baseline: 12 pass, 0 fail"
    return { baseline: "pass" }
  },
  gate: "env",
}

export const PLAN_STEP: Step = {
  id: "plan",
  kind: "model",
  tools: ["read_file", "list_files"],
  contextBudget: 8_000,
  instruction:
    "Produce a strict plan. Return only JSON matching { tasks: [{ id, title, files, criteria }] }.",
  context: (state) => [
    contextBlock({
      id: "task",
      kind: "task",
      source: "input",
      text: state.task,
      required: true,
    }),
    contextBlock({
      id: "stack",
      kind: "artifact",
      source: "repo",
      text: state.stack,
      required: true,
    }),
    contextBlock({
      id: "repo-map",
      kind: "map",
      source: "fragtree",
      text: state.repoMap,
      required: true,
    }),
  ],
  parse: parsePlan,
  gate: "plan",
  apply: applyPlan,
}

export const BUILD_STEP: Step = {
  id: "build",
  kind: "model",
  tools: ["read_file", "write_file", "run_tests"],
  contextBudget: 12_000,
  instruction: "Implement exactly one task. Use the tools. Return a short report.",
  context: (state) => {
    const task = state.currentTask ?? state.plan?.tasks[0]
    return [
      contextBlock({
        id: "task",
        kind: "task",
        source: "plan",
        text: task ? `${task.id}: ${task.title}` : state.task,
        required: true,
      }),
      contextBlock({
        id: "files",
        kind: "file",
        source: "plan",
        text: (task?.files ?? []).join("\n"),
        required: true,
      }),
      contextBlock({
        id: "criteria",
        kind: "plan",
        source: "plan",
        text: (task?.criteria ?? []).join("\n"),
        required: true,
      }),
      ...(state.lastFailure !== undefined
        ? [
            contextBlock({
              id: "failure",
              kind: "failure",
              source: "gate",
              text: state.lastFailure,
              required: true,
            }),
          ]
        : []),
      contextBlock({ id: "repo-map", kind: "map", source: "fragtree", text: state.repoMap }),
    ]
  },
  gate: "build",
}

export const HARDEN_STEP: Step = {
  id: "harden",
  kind: "model",
  tools: ["read_file", "write_file", "run_tests"],
  contextBudget: 12_000,
  instruction: "Refactor for clarity and security without changing behaviour. Return a short report.",
  context: (state) => {
    const criteria = (state.plan?.tasks ?? []).flatMap((task) => task.criteria)
    return [
      contextBlock({
        id: "diff",
        kind: "diff",
        source: "workspace",
        text: state.diff ?? "",
        required: true,
      }),
      contextBlock({
        id: "tests",
        kind: "test",
        source: "runner",
        text: state.testOutput ?? "",
        required: true,
      }),
      contextBlock({
        id: "criteria",
        kind: "plan",
        source: "plan",
        text: criteria.join("\n"),
        required: true,
      }),
      ...(state.securityFindings ?? []).map((finding, index) =>
        contextBlock({
          id: `security-${index}`,
          kind: "security",
          source: "scanner",
          text: finding,
          required: true,
        }),
      ),
    ]
  },
  gate: "harden",
}

/**
 * Declaration only. The integrate step is deterministic, has no context and no
 * tools, and the landing implementation is deliberately absent. The pipeline
 * refuses to execute a deterministic step without a runner rather than
 * pretending the change landed.
 */
export const INTEGRATE_STEP: Step = {
  id: "integrate",
  kind: "deterministic",
  tools: [],
  contextBudget: 0,
  instruction: "",
  context: () => [],
  gate: "integrate",
}

/** The executable demo pipeline: env, plan, build and harden. */
export const DEFAULT_STEPS: readonly Step[] = [ENV_STEP, PLAN_STEP, BUILD_STEP, HARDEN_STEP]

/** The full declaration, including the private landing step. */
export const PIPELINE_STEPS: readonly Step[] = [...DEFAULT_STEPS, INTEGRATE_STEP]
