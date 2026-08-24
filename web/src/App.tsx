/**
 * 组合根：会话列表 + WS 订阅 + 对话流 + 顶栏控件 + 审批/新建弹窗。
 * 数据流照占位 UI 的形状：REST 拿历史/控制，WS 收实时事件（API.md）。
 *
 * 消息模型（M13）：一条消息 = 文本段 + 工具段交错。tool_use 出工具段；
 * tool_result 不出段，按 tool_use_id 回填到对应工具段（状态 ✓/✗ + 输出）。
 * 历史和实时帧共用 lib/segments.ts 一份提取逻辑。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, post, token } from './lib/api'
import { groupName, sessionTitle } from './lib/format'
import { humanText, segmentsFromContent, textOfSegments, toolResultsFromContent } from './lib/segments'
import type { ToolResultInfo } from './lib/segments'
import type {
  Approval, ChatMsg, HistoryMessage, HubEvent, ModelOption, ProjectChoice, SessionState,
  SessionSummary, ToolSeg,
} from './types'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { Sidebar } from './components/Sidebar'
import { Chat } from './components/Chat'
import { Composer } from './components/Composer'
import type { ContextInfo } from './components/ContextRing'
import { ApprovalDialog } from './components/ApprovalDialog'
import { DraftView } from './components/DraftView'
import { QuestionDialog } from './components/QuestionDialog'

let keySeq = 0
const nextKey = () => `m${++keySeq}`

const STATE_LABEL: Record<SessionState, string> = {
  idle: '空闲',
  running: '运行中',
  'waiting-approval': '等待审批',
}

export default function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [sessionId, setSessionId] = useState<string | null>(
    () => new URLSearchParams(location.search).get('session'),
  )
  const [msgs, setMsgs] = useState<ChatMsg[]>([])
  const [stream, setStream] = useState('')
  const [state, setState] = useState<SessionState>('idle')
  const [approval, setApproval] = useState<Approval | null>(null)
  const [usage, setUsage] = useState('')
  const [models, setModels] = useState<ModelOption[]>([])
  const [permMode, setPermMode] = useState('default')
  const [modelValue, setModelValue] = useState<string | null>(null)
  const [modelResolved, setModelResolved] = useState<string | null>(null)
  const [effort, setEffort] = useState<string | null>(null)
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null)
  const [connected, setConnected] = useState(true)
  const modelsLoadedRef = useRef(false)
  /** 草稿态发出的首条消息：等会话选中、effect 重置完再乐观渲染 + 发送 */
  const pendingPromptRef = useRef<string | null>(null)
  /** 草稿态里选好的模型/思考/权限：会话创建后、首条 prompt 前按序应用 */
  const pendingSetupRef = useRef<{ model: string | null; effort: string | null; permMode: string | null } | null>(null)
  /** get_settings 的 applied.effort：effort 的显示默认值（M27） */
  const defaultEffortRef = useRef<string | null>(null)
  /** 最近一次活跃会话的项目目录 —— 草稿态选择器的默认值 */
  const lastCwdRef = useRef<string | null>(null)
  /** tool_use id → 它渲染在哪条消息的哪个段（tool_result 回填用） */
  const toolLocRef = useRef(new Map<string, { key: string; si: number }>())

  const appendMsg = useCallback((m: Omit<ChatMsg, 'key'>): string => {
    const key = nextKey()
    setMsgs((prev) => [...prev, { ...m, key }])
    return key
  }, [])

  const appendError = useCallback((text: string) => {
    // 同一个失败常从两条路各报一次（信封错误 + 引擎 error 帧）→ 连续同文去重
    setMsgs((prev) => {
      const last = prev[prev.length - 1]
      const full = `⚠ ${text}`
      if (last !== undefined && last.role === 'error' && textOfSegments(last.segments) === full) {
        return prev
      }
      return [...prev, {
        key: nextKey(), role: 'error', segments: [{ kind: 'text', text: full }], meta: null, sidechain: null,
      }]
    })
  }, [])

  /** tool_result 回填：改对应工具段的状态和输出 */
  const patchToolResults = useCallback((results: ToolResultInfo[]) => {
    const hits = results.filter((r) => r.id !== null && toolLocRef.current.has(r.id))
    if (hits.length === 0) return
    setMsgs((prev) =>
      prev.map((m) => {
        const mine = hits.filter((r) => toolLocRef.current.get(r.id!)!.key === m.key)
        if (mine.length === 0) return m
        const segments = m.segments.map((seg, si) => {
          const hit = mine.find((r) => toolLocRef.current.get(r.id!)!.si === si)
          if (hit === undefined || seg.kind !== 'tool') return seg
          return {
            ...seg,
            status: hit.isError ? ('error' as const) : ('ok' as const),
            result: hit.text !== '' ? hit.text : seg.result,
          }
        })
        return { ...m, segments }
      }),
    )
  }, [])

  /* ── 会话列表 ──
     每轮 result 后也刷一次（M20）：CC 把第一轮写进 jsonl 后，新会话的
     标题（首条人话）才出现 —— 顶栏和侧栏跟着从 uuid 变成真标题。
     列表扫描有 mtime 缓存（M15），刷新是毫秒级的。 */
  const refreshSessions = useCallback(async () => {
    const d = await api<{ sessions: SessionSummary[] }>('/api/v1/sessions')
    setSessions((prev) => {
      // 新建会话在 jsonl 落盘前不在服务端列表里 —— 保住乐观条目（project_slug 为空标记）
      const optimistic = prev.filter(
        (p) => p.project_slug === '' && !d.sessions.some((s) => s.session_id === p.session_id),
      )
      return [...optimistic, ...d.sessions]
    })
  }, [])

  useEffect(() => {
    refreshSessions()
      .catch((e: Error) => appendError(e.message))
      .finally(() => setSessionsLoading(false))
  }, [refreshSessions, appendError])

  /** context 窗口用量（M30）：引擎活着才有，拿不到就不显示 */
  const loadContext = useCallback(async (id: string) => {
    try {
      const d = await api<{
        total_tokens: number; max_tokens: number; percentage: number; estimated?: boolean
      } | null>(`/api/v1/sessions/${id}/context`)
      setContextInfo(
        d !== null && typeof d.max_tokens === 'number' && d.max_tokens > 0
          ? { total: d.total_tokens, max: d.max_tokens, percentage: d.percentage, estimated: d.estimated === true }
          : null,
      )
    } catch {
      setContextInfo(null)
    }
  }, [])

  /* ── 用量（拿不到就不显示，D5）── */
  const loadUsage = useCallback(async (id: string) => {
    try {
      const parts: string[] = []
      const s = await api<{
        total_cost_usd: number | null
        total: { input_tokens: number; output_tokens: number } | null
      } | null>(`/api/v1/sessions/${id}/usage`)
      if (s !== null) {
        if (typeof s.total_cost_usd === 'number') parts.push(`$${s.total_cost_usd.toFixed(4)}`)
        else if (s.total) parts.push(`${s.total.input_tokens}+${s.total.output_tokens} tok`)
      }
      const rl = await api<{
        five_hour?: { utilization?: number }
        seven_day?: { utilization?: number }
      } | null>(`/api/v1/usage?session=${id}`)
      if (rl?.five_hour?.utilization != null) parts.push(`5h ${Math.round(rl.five_hour.utilization)}%`)
      if (rl?.seven_day?.utilization != null) parts.push(`7d ${Math.round(rl.seven_day.utilization)}%`)
      setUsage(parts.join(' · '))
    } catch {
      setUsage('')
    }
  }, [])

  /**
   * 模型列表 + 默认 effort：账户级 /api/v1/models（M29）。
   * 服务端用一次性空白引擎拉（不借真实会话 —— resume 大会话冷启动
   * 会超握手超时，这正是「首次要点击才加载」的根因），结果缓存。
   */
  const loadModels = useCallback(async () => {
    if (modelsLoadedRef.current) return
    try {
      const d = await api<{
        models?: {
          value?: string; id?: string; displayName?: string; label?: string
          description?: string; resolvedModel?: string
          supportsEffort?: boolean; supportedEffortLevels?: string[]
        }[]
        settings?: { applied?: { effort?: string | null; model?: string | null } } | null
      }>('/api/v1/models')
      const opts: ModelOption[] = []
      for (const m of d.models ?? []) {
        const value = m.value ?? m.id
        if (value !== undefined) {
          opts.push({
            value,
            label: m.displayName ?? m.label ?? value,
            description: m.description ?? null,
            resolved: m.resolvedModel ?? null,
            supportsEffort: m.supportsEffort === true,
            effortLevels: m.supportedEffortLevels ?? [],
          })
        }
      }
      setModels(opts)
      modelsLoadedRef.current = true
      const effortDefault = d.settings?.applied?.effort
      const modelDefault = d.settings?.applied?.model
      if (typeof effortDefault === 'string') {
        defaultEffortRef.current = effortDefault
        setEffort((prev) => prev ?? effortDefault)
      }
      if (typeof modelDefault === 'string') setModelResolved((prev) => prev ?? modelDefault)
    } catch {
      setModels([])
    }
  }, [])

  // 页面一挂载就拉（不等会话列表；服务端有缓存，重复调用无成本）
  useEffect(() => {
    void loadModels()
  }, [loadModels])

  /** 新格式 subagent：按 meta.toolUseId 挂到对应工具段（M17） */
  const loadSubagents = useCallback(async (id: string) => {
    try {
      const d = await api<{
        agents: { agent_id: string; tool_use_id: string | null; agent_type: string | null; description: string | null }[]
      }>(`/api/v1/sessions/${id}/subagents`)
      const byTool = new Map<string, { id: string; label: string }>()
      for (const a of d.agents) {
        if (a.tool_use_id === null) continue
        const label = `子代理 · ${a.agent_type ?? 'agent'}${a.description !== null ? ` · ${a.description}` : ''}`
        byTool.set(a.tool_use_id, { id: a.agent_id, label: label.length > 60 ? `${label.slice(0, 60)}…` : label })
      }
      if (byTool.size === 0) return
      setMsgs((prev) =>
        prev.map((m) => {
          if (!m.segments.some((seg) => seg.kind === 'tool' && seg.id !== null && byTool.has(seg.id))) return m
          return {
            ...m,
            segments: m.segments.map((seg) =>
              seg.kind === 'tool' && seg.id !== null && byTool.has(seg.id)
                ? { ...seg, agent: byTool.get(seg.id)! }
                : seg,
            ),
          }
        }),
      )
    } catch {
      // subagent 视图是锦上添花，拿不到不打扰
    }
  }, [])

  /** 面板打开时的兜底：首拉失败（网络/服务器重启）→ 重试 */
  const ensureModels = useCallback(() => {
    if (!modelsLoadedRef.current) void loadModels()
  }, [loadModels])

  const loadHistory = useCallback(async (id: string) => {
    try {
      const d = await api<{ messages: HistoryMessage[] }>(`/api/v1/sessions/${id}/history?limit=100`)
      const out: ChatMsg[] = []
      toolLocRef.current = new Map()
      for (const m of d.messages) {
        const content = m.content ?? m.text
        if (m.role === 'assistant') {
          const segments = segmentsFromContent(content)
          if (segments.length === 0) continue
          const key = nextKey()
          segments.forEach((seg, si) => {
            if (seg.kind === 'tool' && seg.id !== null) toolLocRef.current.set(seg.id, { key, si })
          })
          const sidechain =
            typeof m.uuid === 'string' && (m.sidechain_count ?? 0) > 0
              ? { uuid: m.uuid, count: m.sidechain_count! }
              : null
          out.push({ key, role: 'assistant', segments, meta: m.model, sidechain })
        } else if (m.role === 'user') {
          // tool_result 回填到已登记的工具段（此时还没 setState，直接改本地数组）
          for (const r of toolResultsFromContent(content)) {
            const loc = r.id !== null ? toolLocRef.current.get(r.id) : undefined
            if (loc === undefined) continue
            const msg = out.find((x) => x.key === loc.key)
            const seg = msg?.segments[loc.si]
            if (seg !== undefined && seg.kind === 'tool') {
              const t = seg as ToolSeg
              t.status = r.isError ? 'error' : 'ok'
              if (r.text !== '') t.result = r.text
            }
          }
          const text = humanText(textOfSegments(segmentsFromContent(content)))
          if (text !== '') {
            out.push({ key: nextKey(), role: 'user', segments: [{ kind: 'text', text }], meta: null, sidechain: null })
          }
        }
      }
      setMsgs(out)
      void loadSubagents(id)
    } catch (e) {
      appendError((e as Error).message)
    }
  }, [appendError, loadSubagents])

  /* ── 选中会话：历史 + WS 订阅（断线每 3s 重连，接回后补历史/用量）── */
  useEffect(() => {
    if (sessionId === null) return
    setMsgs([])
    setStream('')
    setApproval(null)
    setModelValue(null)
    setModelResolved(null)
    setEffort(defaultEffortRef.current)
    setPermMode('default')
    toolLocRef.current = new Map()

    const pending = pendingPromptRef.current
    const setup = pendingSetupRef.current
    pendingPromptRef.current = null
    pendingSetupRef.current = null
    if (pending !== null) {
      // 草稿态创建的新会话：没有历史可拉（拉了还会覆盖乐观气泡），直接发首条。
      // 草稿里选过的模型/思考/权限先恢复显示（上面刚被重置），再按序应用 ——
      // 控制请求都确认后才发 prompt，保证首轮就用上。
      setMsgs([{ key: nextKey(), role: 'user', segments: [{ kind: 'text', text: pending }], meta: null, sidechain: null }])
      if (setup?.model != null) setModelValue(setup.model)
      if (setup?.effort != null) setEffort(setup.effort)
      if (setup?.permMode != null) setPermMode(setup.permMode)
      void (async () => {
        try {
          if (setup?.model != null) await post(`/api/v1/sessions/${sessionId}/model`, { model: setup.model })
          if (setup?.effort != null) await post(`/api/v1/sessions/${sessionId}/effort`, { effort: setup.effort })
          if (setup?.permMode != null) {
            await post(`/api/v1/sessions/${sessionId}/permission-mode`, { mode: setup.permMode })
          }
          await post(`/api/v1/sessions/${sessionId}/prompt`, { text: pending })
        } catch (e) {
          appendError((e as Error).message)
        }
      })()
    } else {
      void loadHistory(sessionId)
    }
    setContextInfo(null)
    void loadContext(sessionId)
    void loadUsage(sessionId)
    void loadModels()

    let closedByUs = false
    let dropped = false
    let ws: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | null = null

    const onMessage = (ev: MessageEvent<string>) => {
      const e = JSON.parse(ev.data) as HubEvent
      const data = e.data as Record<string, unknown>
      switch (e.event) {
        case 'state':
          setState(data.state as SessionState)
          break
        case 'delta': {
          const evt = data.event as { type?: string; delta?: { type?: string; text?: string } } | undefined
          if (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            setStream((s) => s + (evt.delta?.text ?? ''))
          }
          break
        }
        case 'message': {
          const message = data.message as Record<string, unknown> | undefined
          // init 帧（M24）：把引擎实际在用的模型/权限模式同步进 UI
          if (data.type === 'system' && data.subtype === 'init') {
            if (typeof data.model === 'string') setModelResolved(data.model)
            if (typeof data.permissionMode === 'string') setPermMode(data.permissionMode)
            break
          }
          // subagent 的实时帧（M17）：不进主流，计数归到发起它的工具行（Task 等）
          const parentTool = data.parent_tool_use_id
          if (typeof parentTool === 'string' && (data.type === 'assistant' || data.type === 'user')) {
            const loc = toolLocRef.current.get(parentTool)
            if (loc !== undefined) {
              setMsgs((prev) =>
                prev.map((m) =>
                  m.key !== loc.key
                    ? m
                    : {
                        ...m,
                        segments: m.segments.map((seg, si) =>
                          si === loc.si && seg.kind === 'tool'
                            ? { ...seg, subCount: seg.subCount + 1 }
                            : seg,
                        ),
                      },
                ),
              )
            }
            break
          }
          if (data.type === 'assistant' && message !== undefined) {
            const segments = segmentsFromContent(message.content)
            if (segments.length > 0) {
              setStream('')
              const key = nextKey()
              segments.forEach((seg, si) => {
                if (seg.kind === 'tool' && seg.id !== null) toolLocRef.current.set(seg.id, { key, si })
              })
              const model = message.model
              if (typeof model === 'string') setModelResolved(model)
              setMsgs((prev) => [...prev, {
                key, role: 'assistant', segments,
                meta: typeof model === 'string' ? model : null,
                sidechain: null,
              }])
            }
          } else if (data.type === 'user' && message !== undefined) {
            patchToolResults(toolResultsFromContent(message.content))
            const text = humanText(textOfSegments(segmentsFromContent(message.content)))
            if (text !== '') {
              // 别的标签页发的也渲染；自己发的已乐观渲染 → 和上一条同文本就跳过
              setMsgs((prev) => {
                const last = prev[prev.length - 1]
                if (last !== undefined && last.role === 'user' && textOfSegments(last.segments) === text) {
                  return prev
                }
                return [...prev, { key: nextKey(), role: 'user', segments: [{ kind: 'text', text }], meta: null, sidechain: null }]
              })
            }
          } else if (data.type === 'result') {
            setStream('')
            void loadUsage(sessionId)
            void loadContext(sessionId) // context 环跟着每轮更新
            void loadSubagents(sessionId) // 本轮新 spawn 的 subagent 落盘了，补锚点
            refreshSessions().catch(() => {}) // 标题/排序跟随（新会话从 uuid 变真标题）
          }
          break
        }
        case 'approval':
          setApproval({
            requestId: data.requestId as string,
            tool_name: (data.tool_name as string | null) ?? null,
            input: data.input,
          })
          break
        case 'approval_resolved':
          setApproval((a) => (a !== null && a.requestId === data.requestId ? null : a))
          break
        case 'rate_limit':
          void loadUsage(sessionId)
          break
        case 'error':
          appendError(String(data.message))
          break
      }
    }

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(
        `${proto}://${location.host}/api/v1/ws?session=${sessionId}`,
        `cc-web.bearer.${token}`,
      )
      ws.onmessage = onMessage
      ws.onopen = () => {
        setConnected(true)
        if (dropped) {
          // 服务器重启过：hub 的内存 buffer 没了，从 jsonl 补全历史
          dropped = false
          void loadHistory(sessionId)
          void loadUsage(sessionId)
        }
      }
      ws.onclose = () => {
        if (closedByUs) return
        setConnected(false)
        dropped = true
        retry = setTimeout(connect, 3000)
      }
    }
    connect()

    return () => {
      closedByUs = true
      if (retry !== null) clearTimeout(retry)
      ws?.close()
    }
  }, [sessionId, appendError, loadHistory, loadUsage, loadModels, loadSubagents, loadContext, patchToolResults, refreshSessions])

  const selectSession = useCallback((id: string) => {
    setSessionId(id)
    history.replaceState(null, '', `?session=${id}`)
  }, [])

  const sendPrompt = useCallback(
    (text: string) => {
      if (sessionId === null) return
      appendMsg({ role: 'user', segments: [{ kind: 'text', text }], meta: null, sidechain: null })
      post(`/api/v1/sessions/${sessionId}/prompt`, { text }).catch((e: Error) => appendError(e.message))
    },
    [sessionId, appendMsg, appendError],
  )

  const pickModel = useCallback(
    (value: string) => {
      if (sessionId === null) {
        setModelValue(value) // 草稿态：先记下，首条消息时应用
        return
      }
      const prev = modelValue
      setModelValue(value)
      post(`/api/v1/sessions/${sessionId}/model`, { model: value }).catch((e: Error) => {
        setModelValue(prev)
        appendError(e.message)
      })
    },
    [sessionId, modelValue, appendError],
  )

  const pickEffort = useCallback(
    (level: string) => {
      if (sessionId === null) {
        setEffort(level)
        return
      }
      const prev = effort
      setEffort(level)
      post(`/api/v1/sessions/${sessionId}/effort`, { effort: level }).catch((e: Error) => {
        setEffort(prev)
        appendError(e.message)
      })
    },
    [sessionId, effort, appendError],
  )

  const pickPermMode = useCallback(
    (next: string) => {
      if (sessionId === null) {
        setPermMode(next)
        return
      }
      const prev = permMode
      setPermMode(next)
      post(`/api/v1/sessions/${sessionId}/permission-mode`, { mode: next }).catch((e: Error) => {
        setPermMode(prev) // 切换被拒（或引擎没起来）→ 回滚，不留假状态
        appendError(e.message)
      })
    },
    [sessionId, permMode, appendError],
  )

  const interrupt = useCallback(() => {
    if (sessionId === null) return
    post(`/api/v1/sessions/${sessionId}/interrupt`).catch((e: Error) => appendError(e.message))
  }, [sessionId, appendError])

  const decideApproval = useCallback(
    (behavior: 'allow' | 'deny') => {
      if (sessionId === null || approval === null) return
      const body = behavior === 'allow' ? { behavior } : { behavior, message: 'denied from cc-web' }
      post(`/api/v1/sessions/${sessionId}/approvals/${approval.requestId}`, body).catch((e: Error) =>
        appendError(e.message),
      )
    },
    [sessionId, approval, appendError],
  )

  /** AskUserQuestion：allow + updatedInput 把答案塞回工具入参 */
  const answerQuestion = useCallback(
    (updatedInput: Record<string, unknown>) => {
      if (sessionId === null || approval === null) return
      post(`/api/v1/sessions/${sessionId}/approvals/${approval.requestId}`, {
        behavior: 'allow',
        updatedInput,
      }).catch((e: Error) => appendError(e.message))
    },
    [sessionId, approval, appendError],
  )

  /* ── 草稿态：新建会话 = 回到主视图，首条消息发送时才创建（M21）── */
  const projects = useMemo<ProjectChoice[]>(() => {
    const seen = new Set<string>()
    const out: ProjectChoice[] = []
    for (const s of sessions) {
      if (s.cwd === null || seen.has(s.cwd)) continue
      seen.add(s.cwd)
      out.push({ cwd: s.cwd, name: groupName(s) })
    }
    return out
  }, [sessions])

  const enterDraft = useCallback(() => {
    setSessionId(null)
    history.replaceState(null, '', location.pathname)
  }, [])

  const draftSend = useCallback(
    (cwd: string, text: string) => {
      pendingSetupRef.current = {
        model: modelValue,
        effort,
        permMode: permMode !== 'default' ? permMode : null,
      }
      post<{ session_id: string; cwd: string }>('/api/v1/sessions', { cwd })
        .then((d) => {
          setSessions((prev) => [
            {
              session_id: d.session_id,
              project_slug: '',
              cwd: d.cwd,
              first_message: text,
              mtime_ms: Date.now(),
            },
            ...prev,
          ])
          pendingPromptRef.current = text // 会话 effect 重置完再渲染 + 发送
          setSessionId(d.session_id)
          history.replaceState(null, '', `?session=${d.session_id}`)
        })
        .catch((e: Error) => appendError(e.message))
    },
    [appendError, modelValue, effort, permMode],
  )

  const active = sessions.find((s) => s.session_id === sessionId)
  if (active?.cwd != null) lastCwdRef.current = active.cwd

  return (
    <div className="flex h-full">
      <Sidebar
        sessions={sessions}
        loading={sessionsLoading}
        activeId={sessionId}
        onSelect={selectSession}
        onNewSession={enterDraft}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-[50px] flex-wrap items-center gap-3 border-b px-4 py-2.5">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {active !== undefined ? sessionTitle(active) : 'cc-web'}
          </span>
          {sessionId !== null && (
            <>
              <Badge
                variant={
                  !connected
                    ? 'destructive'
                    : state === 'running'
                      ? 'accent'
                      : state === 'waiting-approval'
                        ? 'warning'
                        : 'default'
                }
              >
                <span
                  className={cn(
                    'size-[7px] rounded-full bg-current',
                    (state === 'running' || !connected) && 'animate-pulse',
                  )}
                />
                {connected ? STATE_LABEL[state] : '已断线，重连中…'}
              </Badge>
              {usage !== '' && <span className="text-xs text-faint tabular-nums">{usage}</span>}
            </>
          )}
        </header>
        {sessionId === null ? (
          <DraftView
            projects={projects}
            defaultCwd={lastCwdRef.current}
            onSend={draftSend}
            permMode={permMode}
            onPermMode={pickPermMode}
            models={models}
            modelValue={modelValue}
            effort={effort}
            onModel={pickModel}
            onEffort={pickEffort}
            onModelMenuOpen={ensureModels}
          />
        ) : (
          <>
            <Chat messages={msgs} streamText={stream} sessionId={sessionId} />
            <Composer
              disabled={false}
              running={state !== 'idle'}
              onSend={sendPrompt}
              onInterrupt={interrupt}
              permMode={permMode}
              onPermMode={pickPermMode}
              models={models}
              modelValue={modelValue}
              modelResolved={modelResolved}
              effort={effort}
              onModel={pickModel}
              onEffort={pickEffort}
              onModelMenuOpen={ensureModels}
              context={contextInfo}
            />
          </>
        )}
      </div>
      {approval !== null &&
        (approval.tool_name === 'AskUserQuestion' ? (
          <QuestionDialog
            approval={approval}
            onAnswer={answerQuestion}
            onDeny={() => decideApproval('deny')}
          />
        ) : (
          <ApprovalDialog approval={approval} onDecide={decideApproval} />
        ))}

    </div>
  )
}
