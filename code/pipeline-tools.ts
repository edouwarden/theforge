/**
 * Per-step tool policy.
 *
 * A step declares an allowlist. The model only sees those tools, and a call
 * that names a different tool fails before execution.
 */

import type { ToolPort } from "./agent-loop-types"

export function allowTools(registry: ToolPort, names: readonly string[]): ToolPort {
  const allowed = new Set(names)
  return {
    specs: registry.specs.filter((spec) => allowed.has(spec.name)),
    async execute(call) {
      if (!allowed.has(call.name)) {
        return {
          name: call.name,
          ok: false,
          content: `tool "${call.name}" is not allowed for this step`,
        }
      }
      return registry.execute(call)
    },
  }
}
