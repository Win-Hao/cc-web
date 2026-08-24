/**
 * user / assistant message 的 content 有两种形态：
 * 字符串，或 block 数组（取第一个 text block）。
 * tool_result 等纯工具 block 提不出文本 → null。
 */
export function extractText(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null
  const content = (message as Record<string, unknown>).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') return b.text
    }
  }
  return null
}
