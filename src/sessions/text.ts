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

/**
 * 剥掉打头的成对元信息块：CC 会往 user 消息前面注入
 * <local-command-caveat> / <ide_opened_file> / <command-name> … 这类
 * XML 风格标签，人话（如果有）跟在后面。剥不干净（未闭合/剥完还是
 * '<' 开头）→ ''，调用方跳过这条。
 */
export function stripMetaBlocks(text: string): string {
  let t = text.trimStart()
  while (t.startsWith('<')) {
    const m = /^<([a-zA-Z][\w-]*)[^>]*>/.exec(t)
    if (m === null) return ''
    const close = `</${m[1]}>`
    const end = t.indexOf(close)
    if (end === -1) return ''
    t = t.slice(end + close.length).trimStart()
  }
  return t
}
