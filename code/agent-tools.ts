/**
 * The tool boundary of the agent loop.
 *
 * A tool call is untrusted output from the model. It is validated, executed
 * and capped here. A malformed call and a thrown tool both become failed
 * results: the model can read them and recover, and neither can escape the
 * loop as an exception.
 */

import type { ToolCall, ToolResult, ToolPort, ToolSpec } from "./agent-loop-types"

export const DEFAULT_MAX_TOOL_RESULT_CHARS = 8_000

/**
 * Validate and execute one call, then cap its content.
 *
 * `spec` is the matching tool declaration, or `undefined` when the model
 * invented a name. An invented tool is rejected by the tool port, not here.
 */
export async function runTool(
  tools: ToolPort,
  spec: ToolSpec | undefined,
  call: ToolCall,
  maxChars = DEFAULT_MAX_TOOL_RESULT_CHARS,
): Promise<ToolResult> {
  const problem = spec?.validate?.(call.args ?? {})
  if (problem !== undefined) {
    return { name: call.name, ok: false, content: `invalid arguments: ${problem}` }
  }

  try {
    const result = await tools.execute(call)
    return capResult({ ...result, name: call.name }, maxChars)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { name: call.name, ok: false, content: `tool error: ${message}` }
  }
}

/** Tool output is context too; cap it before it enters the next prompt. */
function capResult(result: ToolResult, maxChars: number): ToolResult {
  const limit = Number.isFinite(maxChars)
    ? Math.max(0, Math.floor(maxChars))
    : DEFAULT_MAX_TOOL_RESULT_CHARS
  if (result.content.length <= limit) return result
  return {
    ...result,
    content: `${result.content.slice(0, limit)}\n\n[tool result truncated at ${limit} chars]`,
  }
}
