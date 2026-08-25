/**
 * M1：NDJSON 行解析器。
 *
 * 引擎 stdout 是 NDJSON 流（PROTOCOL §1）。TCP/管道不保证按行对齐，
 * 所以这里按 chunk 累积、见到 \n 才出事件：
 *   - 一行拆成多个 chunk → 攒齐才出一个事件（粘包）
 *   - 一个 chunk 里多行 → 出多个事件
 *   - 空行跳过
 *   - 坏 JSON → onError 报出（带原文），继续读下一行，绝不 throw
 */

export interface NdjsonParserHandlers {
  onMessage: (msg: unknown) => void
  onError: (err: Error, rawLine: string) => void
  /** 每个非空行解析前的原文（契约测试录音用，D4） */
  onLine?: (rawLine: string) => void
}

export class NdjsonParser {
  private buf = ''
  private readonly handlers: NdjsonParserHandlers

  constructor(handlers: NdjsonParserHandlers) {
    this.handlers = handlers
  }

  push(chunk: string): void {
    this.buf += chunk
    for (;;) {
      const i = this.buf.indexOf('\n')
      if (i === -1) return
      const line = this.buf.slice(0, i)
      this.buf = this.buf.slice(i + 1)
      this.handleLine(line)
    }
  }

  /** 流结束时残 buffer（没有 \n 结尾）也作为一帧交出。 */
  end(): void {
    const rest = this.buf
    this.buf = ''
    if (rest !== '') this.handleLine(rest)
  }

  private handleLine(line: string): void {
    if (line.trim() === '') return
    this.handlers.onLine?.(line)
    try {
      this.handlers.onMessage(JSON.parse(line))
    } catch (err) {
      this.handlers.onError(err instanceof Error ? err : new Error(String(err)), line)
    }
  }
}
