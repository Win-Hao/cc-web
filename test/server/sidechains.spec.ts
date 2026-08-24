/**
 * M17：subagent/sidechain 视图的数据面。
 * history 给锚点消息带 sidechain_count；/sidechains/:uuid 回整组消息。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { createApp } from '#/server/app.js'

let root: string
const SID = 'dddddddd-0000-0000-0000-00000000000d'

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-web-side-'))
  mkdirSync(join(root, '-Users-x-proj-d'))
  const row = (o: Record<string, unknown>) => JSON.stringify({ cwd: '/Users/x/proj-d', ...o })
  writeFileSync(
    join(root, '-Users-x-proj-d', `${SID}.jsonl`),
    [
      row({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: '查一下' } }),
      // 主线 assistant（锚点）：发起 Task
      row({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Task', input: { description: '去查' } }] } }),
      // subagent 消息链（isSidechain，parentUuid 锚到 a1）
      row({ type: 'user', uuid: 's1', parentUuid: 'a1', isSidechain: true, message: { role: 'user', content: '子任务开始' } }),
      row({ type: 'assistant', uuid: 's2', parentUuid: 's1', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: '子任务结果' }] } }),
      // 主线继续
      row({ type: 'assistant', uuid: 'a2', parentUuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: '查完了' }] } }),
    ].join('\n') + '\n',
  )
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function getJson(app: Hono, path: string) {
  const res = await app.request(path)
  return (await res.json()) as { code: number; data: { messages: Record<string, unknown>[] } }
}

describe('sidechain 视图', () => {
  it('history 给锚点消息带 sidechain_count，其它消息不带', async () => {
    const app = createApp({ projectsRoot: root })
    const { data } = await getJson(app, `/api/v1/sessions/${SID}/history`)
    const anchor = data.messages.find((m) => m.uuid === 'a1')!
    expect(anchor.sidechain_count).toBe(2)
    const other = data.messages.find((m) => m.uuid === 'a2')!
    expect(other.sidechain_count).toBeUndefined()
    // 主线里不该混进 sidechain 消息
    expect(data.messages.some((m) => m.uuid === 's1' || m.uuid === 's2')).toBe(false)
  })

  it('/sidechains/:uuid 回整组 subagent 消息（行号升序，形状同 history）', async () => {
    const app = createApp({ projectsRoot: root })
    const { code, data } = await getJson(app, `/api/v1/sessions/${SID}/sidechains/a1`)
    expect(code).toBe(0)
    expect(data.messages.map((m) => m.uuid)).toEqual(['s1', 's2'])
    expect(data.messages[1]!.content).toEqual([{ type: 'text', text: '子任务结果' }])
  })

  it('新格式：subagents 目录 → 列表带 toolUseId 锚点，转写可读', async () => {
    const app = createApp({ projectsRoot: root })
    const subDir = join(root, '-Users-x-proj-d', SID, 'subagents')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(
      join(subDir, 'agent-abc123.meta.json'),
      JSON.stringify({ agentType: 'Explore', description: '去探索', toolUseId: 't1', spawnDepth: 1 }),
    )
    writeFileSync(
      join(subDir, 'agent-abc123.jsonl'),
      [
        JSON.stringify({ type: 'user', uuid: 'x1', parentUuid: null, isSidechain: true, message: { role: 'user', content: '子任务' } }),
        JSON.stringify({ type: 'assistant', uuid: 'x2', parentUuid: 'x1', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: '干完了' }] } }),
      ].join('\n') + '\n',
    )

    const list = await getJson(app, `/api/v1/sessions/${SID}/subagents`)
    expect(list.code).toBe(0)
    const agents = (list.data as unknown as { agents: Record<string, unknown>[] }).agents
    expect(agents).toHaveLength(1)
    expect(agents[0]!.agent_id).toBe('abc123')
    expect(agents[0]!.tool_use_id).toBe('t1')
    expect(agents[0]!.agent_type).toBe('Explore')

    const msgs = await getJson(app, `/api/v1/sessions/${SID}/subagents/abc123`)
    expect(msgs.data.messages.map((m) => m.uuid)).toEqual(['x1', 'x2'])
  })

  it('新格式：没有 subagents 目录 / 乱写的 agentId → 空，不报错', async () => {
    const app = createApp({ projectsRoot: root })
    // beforeAll 的会话在上个用例才建目录；这里用不存在的 agent id
    const bad = await getJson(app, `/api/v1/sessions/${SID}/subagents/..%2Fetc`)
    expect(bad.code).toBe(0)
    expect(bad.data.messages).toEqual([])
  })

  it('不是锚点 / 乱写的 uuid → 空组，不报错', async () => {
    const app = createApp({ projectsRoot: root })
    expect((await getJson(app, `/api/v1/sessions/${SID}/sidechains/u1`)).data.messages).toEqual([])
    expect((await getJson(app, `/api/v1/sessions/${SID}/sidechains/..%2Fetc`)).data.messages).toEqual([])
  })
})
