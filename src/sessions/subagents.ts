/**
 * M17：新版 subagent 落盘（PROTOCOL §2）——
 * <slug>/<sessionId>/subagents/agent-<id>.jsonl + agent-<id>.meta.json，
 * meta 的 toolUseId 锚到主转写里 Task/Agent 的 tool_use.id。
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface SubagentInfo {
  agent_id: string
  /** 主转写里发起它的 tool_use.id（前端据此挂到工具行上） */
  tool_use_id: string | null
  agent_type: string | null
  description: string | null
}

/** 会话 jsonl 路径 → subagents 目录（去掉 .jsonl 的同名目录下） */
function subagentsDir(sessionFile: string): string {
  return join(sessionFile.slice(0, -'.jsonl'.length), 'subagents')
}

export async function listSubagents(sessionFile: string): Promise<SubagentInfo[]> {
  const dir = subagentsDir(sessionFile)
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return [] // 没有 subagents 目录 = 这个会话没跑过 subagent
  }
  const out: SubagentInfo[] = []
  for (const f of files) {
    const m = /^agent-([A-Za-z0-9_-]+)\.meta\.json$/.exec(f)
    if (m === null) continue
    let meta: Record<string, unknown> = {}
    try {
      meta = JSON.parse(await readFile(join(dir, f), 'utf8')) as Record<string, unknown>
    } catch {
      // meta 坏了也列出来（还能看转写），字段给 null
    }
    out.push({
      agent_id: m[1]!,
      tool_use_id: typeof meta.toolUseId === 'string' ? meta.toolUseId : null,
      agent_type: typeof meta.agentType === 'string' ? meta.agentType : null,
      description: typeof meta.description === 'string' ? meta.description : null,
    })
  }
  return out
}

/** agent 转写文件路径；id 白名单校验防穿越，文件不存在回 null */
export async function findSubagentFile(sessionFile: string, agentId: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]+$/.test(agentId)) return null
  const p = join(subagentsDir(sessionFile), `agent-${agentId}.jsonl`)
  const s = await stat(p).catch(() => null)
  return s?.isFile() === true ? p : null
}
