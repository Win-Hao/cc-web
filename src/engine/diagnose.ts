/**
 * M41：引擎失败分类（成熟实现的精简版）。
 * 把 stderr 尾巴 / 错误原文归类成用户能行动的信息 —— 裸英文报错
 * 对用户毫无帮助（"engine exited unexpectedly: code=1"）。
 */
export interface EngineFailureDiagnosis {
  code: 'AUTH_REQUIRED' | 'RATE_LIMITED' | 'CONNECTION_DROPPED' | 'BINARY_NOT_FOUND'
  /** 给 UI 的第一行人话；原始报错跟在后面 */
  message: string
  retryable: boolean
}

const RULES: { code: EngineFailureDiagnosis['code']; re: RegExp; message: string; retryable: boolean }[] = [
  {
    code: 'BINARY_NOT_FOUND',
    re: /ENOENT|spawn claude/i,
    message: '找不到 claude 命令 —— 确认已安装 Claude Code 且在 PATH 里',
    retryable: false,
  },
  {
    code: 'AUTH_REQUIRED',
    re: /not logged in|invalid api key|missing api key|authentication[_ ]failed|unauthorized|please run \/login|oauth.*(expired|revoked)|401/i,
    message: '登录态失效 —— 在终端跑一次 claude 并 /login，然后重试',
    retryable: false,
  },
  {
    code: 'RATE_LIMITED',
    re: /rate.?limit|429|too many requests|overloaded|usage limit reached|quota/i,
    message: '额度受限 —— 稍后重试，或打开左下角「套餐用量」查看窗口重置时间',
    retryable: true,
  },
  {
    code: 'CONNECTION_DROPPED',
    re: /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|network error|connection (error|reset|closed|refused|interrupted)|stream (disconnected|error)|socket hang ?up/i,
    message: '与 Anthropic 的连接中断 —— 多为网络抖动，重发即可',
    retryable: true,
  },
]

export function diagnoseEngineFailure(text: string): EngineFailureDiagnosis | null {
  for (const rule of RULES) {
    if (rule.re.test(text)) return { code: rule.code, message: rule.message, retryable: rule.retryable }
  }
  return null
}
