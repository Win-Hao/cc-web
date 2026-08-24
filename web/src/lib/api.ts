/**
 * 信封协议客户端（API.md）：{ code, msg, data, trace_id }，code 0 = 成功。
 * token 从 URL fragment 读（#token=，不进 access log），读到就存
 * sessionStorage，后续刷新/去掉 fragment 也能用。
 */
const hash = new URLSearchParams(location.hash.slice(1))
const fromHash = hash.get('token')
if (fromHash !== null) sessionStorage.setItem('cc-web.token', fromHash)
export const token = fromHash ?? sessionStorage.getItem('cc-web.token') ?? ''

interface Envelope<T> {
  code: number
  msg: string
  data: T
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    })
  } catch {
    // fetch 层失败（连接拒绝/中断）：服务器没在跑或刚重启
    throw new Error('无法连接 cc-web 服务器 —— 进程没在跑？起来后会自动重连')
  }
  const env = (await res.json()) as Envelope<T>
  if (env.code !== 0) throw new Error(env.msg !== '' ? env.msg : `code=${env.code}`)
  return env.data
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
}
