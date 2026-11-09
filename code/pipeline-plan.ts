/**
 * Plan parsing for the PLAN step.
 *
 * A plan is a contract, not prose. If it does not parse, the step fails before
 * code exists. The engine parses YAML; this public slice uses JSON for the same
 * boundary.
 */

import type { Plan } from "./pipeline-types"

export function parsePlan(text: string): Plan {
  let value: unknown
  try {
    value = JSON.parse(stripFences(text))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`plan is not valid JSON: ${message}`)
  }

  if (!isRecord(value) || !Array.isArray(value.tasks)) {
    throw new Error("plan: expected { tasks: [...] }")
  }

  const tasks = value.tasks.map((task, index) => {
    if (!isRecord(task)) throw new Error(`plan: task ${index} is not an object`)
    if (typeof task.id !== "string" || typeof task.title !== "string") {
      throw new Error(`plan: task ${index} needs id and title`)
    }
    if (!isStringArray(task.files)) {
      throw new Error(`plan: task ${index} needs files: string[]`)
    }
    if (!isStringArray(task.criteria)) {
      throw new Error(`plan: task ${index} needs criteria: string[]`)
    }
    return {
      id: task.id,
      title: task.title,
      files: task.files,
      criteria: task.criteria,
    }
  })

  if (tasks.length === 0) throw new Error("plan: at least one task is required")
  return { tasks }
}

function stripFences(text: string): string {
  return text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}
