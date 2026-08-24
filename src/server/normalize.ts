/**
 * 引擎 stdout 帧 → WS 事件名的归一化（纯函数）。
 *
 * 事件表见 API.md：message / delta / state / rate_limit / error。
 * data 一律带原帧 —— 占位 UI 阶段不做字段裁剪，归一化只定事件名；
 * 将来要裁剪也只动这一个文件。
 */
export interface WsMappedEvent {
  event: string
  data: unknown
}

export function frameToWsEvent(frame: unknown): WsMappedEvent | null {
  if (typeof frame !== 'object' || frame === null) return null
  const type = (frame as Record<string, unknown>).type
  switch (type) {
    case 'stream_event':
      // --include-partial-messages 的流式增量帧 → 打字机效果靠它
      return { event: 'delta', data: frame }
    case 'rate_limit_event':
      return { event: 'rate_limit', data: frame }
    case undefined:
      return null
    default:
      // result 帧也走这里：状态转移由 registry 单独发 state 事件，
      // 不在这映射，否则客户端会收到两个 state
      return { event: 'message', data: frame }
  }
}
