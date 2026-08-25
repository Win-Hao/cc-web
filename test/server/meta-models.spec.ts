/**
 * M29：账户级 /api/v1/models —— 一次性空白引擎拉 models+settings，
 * 拉完就停、结果缓存（第二次不再 spawn）。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '#/server/app.js'
import { SessionHub } from '#/server/hub.js'
import { SessionRegistry } from '#/server/registry.js'
import { fakeEngines } from '../fixtures/fake-engine.js'

describe('GET /api/v1/models（账户级元数据）', () => {
  it('一次性引擎：newSessionCwd spawn → 拉完停掉 → 结果缓存不再 spawn', async () => {
    const { factory, calls, all } = fakeEngines({
      auto: {
        list_models: { models: [{ value: 'default', displayName: 'Default' }] },
        get_settings: { applied: { effort: 'max', model: 'claude-opus-5[1m]' } },
        get_context_usage: { totalTokens: 19670, maxTokens: 1000000, percentage: 2 },
        get_usage: { session: {}, rate_limits_available: true, rate_limits: {} },
      },
    })
    const registry = new SessionRegistry({ hub: new SessionHub(), factory })
    const app = createApp({ projectsRoot: mkdtempSync(join(tmpdir(), 'cc-web-meta-')), registry })

    const res1 = await app.request('/api/v1/models')
    const body1 = (await res1.json()) as {
      code: number
      data: { models: { value: string }[]; settings: { applied: { effort: string } } }
    }
    expect(body1.code).toBe(0)
    expect(body1.data.models[0]!.value).toBe('default')
    expect(body1.data.settings.applied.effort).toBe('max')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.opts?.newSessionCwd).toBeTypeOf('string') // 空白引擎，不 resume 任何会话
    await new Promise((r) => setTimeout(r, 20))
    expect(all[0]!.stopped).toBe(true) // 拉完就停

    const res2 = await app.request('/api/v1/models')
    expect(((await res2.json()) as { code: number }).code).toBe(0)
    expect(calls).toHaveLength(1) // 缓存命中，没有第二次 spawn
  })
})
