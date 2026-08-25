/**
 * M14：AskUserQuestion 交互 —— 审批通道的 updatedInput 应答。
 * allow + updatedInput → 原样交给引擎答复（CC 拿它当工具入参）。
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { createApp } from '#/server/app.js'
import { SessionHub } from '#/server/hub.js'
import { SessionRegistry } from '#/server/registry.js'
import { fakeEngines } from '../fixtures/fake-engine.js'

function setup() {
  const { factory, engines } = fakeEngines()
  const registry = new SessionRegistry({ hub: new SessionHub(), factory })
  const app = createApp({ projectsRoot: mkdtempSync(join(tmpdir(), 'cc-web-q-')), registry })
  return { app, registry, engines }
}

async function postJson(app: Hono, path: string, body: unknown) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

const QUESTION_INPUT = {
  questions: [{
    question: '用哪个方案？',
    header: '方案',
    multiSelect: false,
    options: [
      { label: 'A', description: '方案 A' },
      { label: 'B', description: '方案 B' },
    ],
  }],
}

describe('AskUserQuestion 应答（updatedInput 通道）', () => {
  it('allow + updatedInput → 答复原样带回答案', async () => {
    const { app, registry, engines } = setup()
    await registry.ensure('s1')
    const engine = engines.get('s1')!
    engine.approval({ requestId: 'req-q1', tool_name: 'AskUserQuestion', input: QUESTION_INPUT })

    const updatedInput = { ...QUESTION_INPUT, answers: { '用哪个方案？': 'A' } }
    const { body } = await postJson(app, '/api/v1/sessions/s1/approvals/req-q1', {
      behavior: 'allow',
      updatedInput,
    })
    expect(body.code).toBe(0)
    expect(engine.answers).toEqual([{ requestId: 'req-q1', decision: { behavior: 'allow', updatedInput } }])
  })

  it('不带 updatedInput 的普通 allow 行为不变', async () => {
    const { app, registry, engines } = setup()
    await registry.ensure('s1')
    const engine = engines.get('s1')!
    engine.approval({ requestId: 'req-t1' })
    await postJson(app, '/api/v1/sessions/s1/approvals/req-t1', { behavior: 'allow' })
    expect(engine.answers[0]!.decision).toEqual({ behavior: 'allow' })
  })
})
