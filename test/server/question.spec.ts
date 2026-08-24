/**
 * M14：AskUserQuestion 交互 —— 审批通道的 updatedInput 应答。
 * allow + updatedInput → control_response 里原样带回（CC 拿它当工具入参）。
 */
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { createApp } from '#/server/app.js'
import { SessionHub } from '#/server/hub.js'
import { SessionRegistry } from '#/server/registry.js'

interface SentFrame {
  type: string
  response?: { subtype: string; request_id: string; response: Record<string, unknown> }
}

class FakeEngine extends EventEmitter {
  sent: SentFrame[] = []
  async start() {}
  async stop() {}
  send(frame: unknown) {
    this.sent.push(frame as SentFrame)
  }
}

function setup() {
  const hub = new SessionHub()
  const engines = new Map<string, FakeEngine>()
  const registry = new SessionRegistry({
    hub,
    factory: (id) => {
      const e = new FakeEngine()
      engines.set(id, e)
      return e
    },
  })
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
  it('allow + updatedInput → control_response 原样带回答案', async () => {
    const { app, registry, engines } = setup()
    await registry.ensure('s1')
    const engine = engines.get('s1')!
    engine.emit('message', {
      type: 'control_request',
      request_id: 'req-q1',
      request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: QUESTION_INPUT },
    })

    const updatedInput = { ...QUESTION_INPUT, answers: { '用哪个方案？': 'A' } }
    const { body } = await postJson(app, '/api/v1/sessions/s1/approvals/req-q1', {
      behavior: 'allow',
      updatedInput,
    })
    expect(body.code).toBe(0)

    const resp = engine.sent.find((f) => f.type === 'control_response')!
    expect(resp.response!.request_id).toBe('req-q1')
    expect(resp.response!.response).toEqual({ behavior: 'allow', updatedInput })
  })

  it('不带 updatedInput 的普通 allow 行为不变', async () => {
    const { app, registry, engines } = setup()
    await registry.ensure('s1')
    const engine = engines.get('s1')!
    engine.emit('message', {
      type: 'control_request',
      request_id: 'req-t1',
      request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } },
    })
    await postJson(app, '/api/v1/sessions/s1/approvals/req-t1', { behavior: 'allow' })
    const resp = engine.sent.find((f) => f.type === 'control_response')!
    expect(resp.response!.response).toEqual({ behavior: 'allow' })
  })
})
