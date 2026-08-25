/**
 * 组合根：会话列表 + WS 订阅 + 对话流 + 顶栏控件 + 审批/新建弹窗。
 * 数据流：REST 拿历史/控制，WS 收实时事件（API.md）。
 *
 * 消息模型（D7）：历史和实时都是服务器归一化好的 Message，客户端只有两个原语 ——
 * upsert(message)（按 key 追加/替换，replaces 指向被换掉的占位）和
 * append_delta(key, kind, chunk)。tool_result 配对、canceled 判定、subagent 计数、
 * 提示词回显都在服务器；这里不认任何引擎帧。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, post, token } from './lib/api'
import { t, useLang } from './lib/i18n'
import { groupName, sessionTitle } from './lib/format'
import type {
  Approval, ChatItem, Delta, HubEvent, ImageRef, Message, ModelOption, ProjectChoice, SessionState,
  SessionSummary, TurnEnd, TurnStatus,
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

let errSeq = 0

const STATE_KEY = {
  idle: 'stateIdle',
  running: 'stateRunning',
  'waiting-approval': 'stateWaiting',
} as const

/** upsert：同 key 替换；带 replaces 时占位让位给最终消息。历史行的 cursor 不被实时 upsert 抹掉。 */
function upsertItem(prev: ChatItem[], m: Message): ChatItem[] {
  const next = [...prev]
  const at = next.findIndex((x) => x.key === m.key)
  const old = at !== -1 ? (next[at] as Message) : null
  const merged: Message =
    old !== null && old.cursor !== undefined && m.cursor === undefined ? { ...m, cursor: old.cursor } : m
  const ri = m.replaces !== undefined ? next.findIndex((x) => x.key === m.replaces) : -1
  if (at !== -1) {
    next[at] = merged
    if (ri !== -1) next.splice(ri, 1)
  } else if (ri !== -1) {
    next[ri] = merged
  } else {
    next.push(merged)
  }
  return next
}

/** append_delta：落在占位消息的 text / thinking 块上 */
function applyDelta(prev: ChatItem[], d: Delta): ChatItem[] {
  const i = prev.findIndex((x) => x.key === d.key)
  if (i === -1) return prev
  const m = prev[i] as Message
  const next = [...prev]
  next[i] = {
    ...m,
    content: m.content.map((b) =>
      d.kind === 'text' && b.type === 'text'
        ? { ...b, text: b.text + d.chunk }
        : d.kind === 'thinking' && b.type === 'thinking'
          ? { ...b, thinking: b.thinking + d.chunk }
          : b,
    ),
  }
  return next
}

/** 历史页落地：历史为准，已经到手的实时条目（占位 / 快照）跟在后面 */
function mergeHistory(prev: ChatItem[], page: Message[]): ChatItem[] {
  const seen = new Set(page.map((m) => m.key))
  return [...page, ...prev.filter((x) => !seen.has(x.key))]
}

export default function App() {
  useLang()
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionsLoading, setSessionsLoading] = useState(true)
  const [sessionId, setSessionId] = useState<string | null>(
    () => new URLSearchParams(location.search).get('session'),
  )
  const [items, setItems] = useState<ChatItem[]>([])
  /** 历史分页（M51）：还有更早 + 最早 cursor */
  const [historyMore, setHistoryMore] = useState<{ hasMore: boolean; before: number | null }>({ hasMore: false, before: null })
  const loadingOlderRef = useRef(false)
  /**
   * WS 事件游标。首连不带 since（历史来自 /history，进行中的回合服务器直接给快照）；
   * 之后每个事件更新游标，断线重连带真实 seq 只补缺口。
   */
  const lastSeqRef = useRef<number | null>(null)
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
  /** 草稿态发出的首条消息：等会话选中、effect 重置完再发送 */
  const pendingPromptRef = useRef<string | null>(null)
  /** 草稿态里选好的模型/思考/权限：会话创建后、首条 prompt 前按序应用 */
  const pendingSetupRef = useRef<{ model: string | null; effort: string | null; permMode: string | null } | null>(null)
  /** get_settings 的 applied.effort：effort 的显示默认值（M27） */
  const defaultEffortRef = useRef<string | null>(null)
  /** 最近一次活跃会话的项目目录 —— 草稿态选择器的默认值 */
  const lastCwdRef = useRef<string | null>(null)
  /** 回合状态（M47 footer）：state=running 起表，turn_end 落统计 */
  const [turnStart, setTurnStart] = useState<number | null>(null)
  const turnStartRef = useRef<number | null>(null)
  const [turnStats, setTurnStats] = useState<TurnStatus['stats']>(null)
  const [sawContent, setSawContent] = useState(false)

  const appendError = useCallback((text: string) => {
    // 同一个失败常从两条路各报一次（信封错误 + 引擎 error 事件）→ 连续同文去重
    setItems((prev) => {
      const last = prev[prev.length - 1]
      const full = `⚠ ${text}`
      if (last !== undefined && last.role === 'error' && last.text === full) return prev
      return [...prev, { key: `err:${++errSeq}`, role: 'error', text: full, timestamp: new Date().toISOString() }]
    })
  }, [])

  /* ── 会话列表 ──
     每轮结束后也刷一次（M20）：CC 把第一轮写进 jsonl 后，新会话的
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
    // M54：轮询保活 —— 别的会话在跑/跑完，侧栏 spinner 8s 内跟上
    const timer = setInterval(() => {
      refreshSessions().catch(() => {})
    }, 8000)
    return () => clearInterval(timer)
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

  /** 面板打开时的兜底：首拉失败（网络/服务器重启）→ 重试 */
  const ensureModels = useCallback(() => {
    if (!modelsLoadedRef.current) void loadModels()
  }, [loadModels])

  const loadHistory = useCallback(async (id: string) => {
    try {
      const d = await api<{ messages: Message[]; has_more: boolean }>(
        `/api/v1/sessions/${id}/history?limit=100`,
      )
      setItems((prev) => mergeHistory(prev, d.messages))
      setHistoryMore({
        hasMore: d.has_more === true,
        before: d.messages[0]?.cursor ?? null,
      })
    } catch (e) {
      // 分叉/刚创建的会话 jsonl 未落盘 —— 空历史是正常态，不报错
      if ((e as Error).message.includes('not found')) return
      appendError((e as Error).message)
    }
  }, [appendError])

  /**
   * 回合结束后对齐一次最新页：实时期间服务器不知道的东西（subagent 落盘后的
   * agent 标注等）随历史行回来，按 key upsert，不动已加载的更早页。
   */
  const reconcileHistory = useCallback(async (id: string) => {
    try {
      const d = await api<{ messages: Message[] }>(`/api/v1/sessions/${id}/history?limit=100`)
      setItems((prev) => d.messages.reduce(upsertItem, prev))
    } catch {
      // 对齐是锦上添花，拿不到不打扰
    }
  }, [])

  /** 「加载更早的消息」（M51）：before cursor 取上一页，前插 */
  const loadOlder = useCallback(async () => {
    const id = sessionId
    const before = historyMore.before
    if (id === null || before === null || loadingOlderRef.current) return
    loadingOlderRef.current = true
    try {
      const d = await api<{ messages: Message[]; has_more: boolean }>(
        `/api/v1/sessions/${id}/history?limit=100&before=${before}`,
      )
      setItems((prev) => [...d.messages, ...prev])
      setHistoryMore({
        hasMore: d.has_more === true,
        before: d.messages[0]?.cursor ?? null,
      })
    } catch (e) {
      appendError((e as Error).message)
    } finally {
      loadingOlderRef.current = false
    }
  }, [sessionId, historyMore.before, appendError])

  /* ── 选中会话：历史 + WS 订阅（断线每 3s 重连，接回后补历史/用量）── */
  useEffect(() => {
    if (sessionId === null) return
    setItems([])
    setHistoryMore({ hasMore: false, before: null })
    lastSeqRef.current = null
    turnStartRef.current = null
    setTurnStart(null)
    setTurnStats(null)
    setSawContent(false)
    setApproval(null)
    setModelValue(null)
    setModelResolved(null)
    setEffort(defaultEffortRef.current)
    setPermMode('default')

    const pending = pendingPromptRef.current
    const setup = pendingSetupRef.current
    pendingPromptRef.current = null
    pendingSetupRef.current = null
    if (pending !== null) {
      // 草稿态创建的新会话：没有历史可拉，直接发首条（气泡由服务器的占位消息给）。
      // 草稿里选过的模型/思考/权限先恢复显示（上面刚被重置），再按序应用 ——
      // 控制请求都确认后才发 prompt，保证首轮就用上。
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
      // seq 0 = 服务器直发的当前回合快照，不进游标
      if (typeof e.seq === 'number' && e.seq > 0) lastSeqRef.current = e.seq
      switch (e.event) {
        case 'state': {
          const data = e.data as { state: SessionState; model?: string | null; permission_mode?: string | null }
          setState(data.state)
          if (typeof data.model === 'string') setModelResolved(data.model)
          if (typeof data.permission_mode === 'string') setPermMode(data.permission_mode)
          refreshSessions().catch(() => {}) // 本会话状态翻转 → 侧栏指示立即跟上
          if (data.state === 'running') {
            // 同一回合内 running↔waiting-approval 往返不重置起点
            if (turnStartRef.current === null) {
              turnStartRef.current = Date.now()
              setSawContent(false)
              setTurnStats(null)
            }
            setTurnStart(turnStartRef.current)
          } else if (data.state === 'idle') {
            turnStartRef.current = null
            setTurnStart(null)
          }
          break
        }
        case 'message': {
          const m = e.data as Message
          if (m.role === 'assistant') {
            setSawContent(true)
            if (typeof m.model === 'string') setModelResolved(m.model)
          }
          setItems((prev) => upsertItem(prev, m))
          break
        }
        case 'delta':
          setSawContent(true)
          setItems((prev) => applyDelta(prev, e.data as Delta))
          break
        case 'turn_end': {
          const d = e.data as TurnEnd
          setTurnStats({
            durationMs:
              d.duration_ms ?? (turnStartRef.current !== null ? Date.now() - turnStartRef.current : 0),
            outputTokens: d.output_tokens,
            costUsd: d.cost_usd,
          })
          void loadUsage(sessionId)
          void loadContext(sessionId) // context 环跟着每轮更新
          void reconcileHistory(sessionId) // 本轮落盘后的 agent 标注等随历史行补齐
          refreshSessions().catch(() => {}) // 标题/排序跟随（新会话从 uuid 变真标题）
          break
        }
        case 'approval': {
          const data = e.data as { requestId: string; tool_name?: string | null; input: unknown }
          setApproval({ requestId: data.requestId, tool_name: data.tool_name ?? null, input: data.input })
          break
        }
        case 'approval_resolved': {
          const data = e.data as { requestId: string }
          setApproval((a) => (a !== null && a.requestId === data.requestId ? null : a))
          break
        }
        case 'rate_limit':
          void loadUsage(sessionId)
          break
        case 'error':
          appendError(String((e.data as { message: unknown }).message))
          break
      }
    }

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      const since = lastSeqRef.current !== null ? `&since=${lastSeqRef.current}` : ''
      ws = new WebSocket(
        `${proto}://${location.host}/api/v1/ws?session=${sessionId}${since}`,
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
  }, [sessionId, appendError, loadHistory, reconcileHistory, loadUsage, loadModels, loadContext, refreshSessions])

  const selectSession = useCallback((id: string) => {
    setSessionId(id)
    history.replaceState(null, '', `?session=${id}`)
  }, [])

  /** 分叉会话（M55）：新 id 由 CC 发；jsonl 首条消息才落盘 → 先乐观进侧栏 */
  const forkSession = useCallback(
    async (s: SessionSummary) => {
      try {
        const d = await post<{ session_id: string }>(`/api/v1/sessions/${s.session_id}/fork`, {})
        setSessions((prev) => [
          {
            session_id: d.session_id,
            project_slug: '',
            cwd: s.cwd,
            first_message: `${sessionTitle(s)}${t('forkedSuffix')}`,
            mtime_ms: Date.now(),
          },
          ...prev,
        ])
        selectSession(d.session_id)
      } catch (e) {
        appendError((e as Error).message)
      }
    },
    [selectSession, appendError],
  )

  /** 发提示词。气泡不在这里造：服务器接受后立刻广播占位消息，所有标签页同步 */
  const sendPrompt = useCallback(
    (text: string, images: ImageRef[] = []) => {
      if (sessionId === null) return
      post(`/api/v1/sessions/${sessionId}/prompt`, {
        text,
        ...(images.length > 0 ? { images } : {}),
      }).catch((e: Error) => appendError(e.message))
    },
    [sessionId, appendError],
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
          pendingPromptRef.current = text // 会话 effect 重置完再发送
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
        onFork={(s) => void forkSession(s)}
        onRefresh={() => void refreshSessions().catch(() => {})}
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
                {connected ? t(STATE_KEY[state]) : t('offline')}
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
            <Chat
              messages={items}
              hasEarlier={historyMore.hasMore}
              onLoadEarlier={loadOlder}
              turn={{
                running: state !== 'idle',
                preparing: state !== 'idle' && !sawContent,
                startedAt: turnStart,
                stats: turnStats,
              }}
              sessionId={sessionId}
            />
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
