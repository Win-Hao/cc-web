/**
 * M8：REST bearer 鉴权中间件。
 *
 * 这个服务器能读写文件、跑 shell（R6）—— 不提供 bypass-auth 开关，
 * 中间件由组合根（bootstrap）挂上，开发期单元测试不挂而已。
 */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { MiddlewareHandler } from 'hono'

export function bearerAuth(token: string): MiddlewareHandler {
  const expected = Buffer.from(`Bearer ${token}`)
  return async (c, next) => {
    const header = c.req.header('authorization') ?? ''
    const actual = Buffer.from(header)
    const match =
      actual.length === expected.length && timingSafeEqual(actual, expected)
    if (!match) {
      return c.json(
        { code: 40101, msg: 'unauthorized', data: null, trace_id: randomUUID() },
        401,
      )
    }
    await next()
  }
}
