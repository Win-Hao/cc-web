/**
 * 组合根：会话列表 + WS 订阅 + 对话流 + 顶栏控件 + 审批弹窗。
 * 数据流照占位 UI 的形状：REST 拿历史/控制，WS 收实时事件（API.md）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, post, token } from './lib/api'
import { groupName, sessionTitle } from './lib/format'
import type {
  Approval, ChatMsg, HistoryMessage, HubEvent, ModelOption, SessionState, SessionSummary,
} from './types'
import { Sidebar } from './components/Sidebar'
import { Chat } from './components/Chat'
import { Composer } from './components/Composer'
import { ApprovalDialog } from './components/ApprovalDialog'
import { NewSessionDialog } from './components/NewSessionDialog'
import type { ProjectChoice } from './components/NewSessionDialog'

let keySeq = 0
const nextKey = () => `m${++keySeq}`

function textOf(message: unknown): string {
  if (typeof message !== 'object' || message === null) return ''
  const content = (message as Record<string, unknown>).content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text: string } =>
      typeof b === 'object' && b !== null &&
      (b as Record<string, unknown>).type === 'text' &&
      typeof (b as Record<string, unknown>).text === 'string')
    .map((b) => b.text)
    .join('')
}

const STATE_LABEL: Record<SessionState, string> = {
  idle: '空闲',
  running: '运行中',
  'waiting-approval': '等待审批',
}

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

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
  const [connected, setConnected] = useState(true)
  const [showNewDialog, setShowNewDialog] = useState(false)
  const modelsLoadedRef = useRef(false)

  const appendMsg = useCallback((m: Omit<ChatMsg, 'key'>) => {
    setMsgs((prev) => [...prev, { ...m, key: nextKey() }])
  }, [])

  const appendError = useCallback(
    (text: string) => appendMsg({ role: 'error', text: `⚠ ${text}`, meta: null }),
    [appendMsg],
  )

  /* ── 会话列表 ── */
  useEffect(() => {
    api<{ sessions: SessionSummary[] }>('/api/v1/sessions')
      .then((d) => setSessions(d.sessions))
      .catch((e: Error) => appendError(e.message))
      .finally(() => setSessionsLoading(false))
  }, [appendError])

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

  /* ── 模型列表：账户级，只拉一次（每个会话拉会各 spawn 一个引擎）── */
  const loadModels = useCallback(async (id: string) => {
    if (modelsLoadedRef.current) return
    try {
      const d = await api<{ models?: { value?: string; id?: string; displayName?: string; label?: string }[] }>(
        `/api/v1/sessions/${id}/models`,
      )
      const opts: ModelOption[] = []
      for (const m of d.models ?? []) {
        const value = m.value ?? m.id
        if (value !== undefined) opts.push({ value, label: m.displayName ?? m.label ?? value })
      }
      setModels(opts)
      modelsLoadedRef.current = true
    } catch {
      setModels([])
    }
  }, [])

  const loadHistory = useCallback(async (id: string) => {
    try {
      const d = await api<{ messages: HistoryMessage[] }>(`/api/v1/sessions/${id}/history?limit=100`)
      setMsgs(
        d.messages
          .filter((m) => m.text !== null && m.text !== '')
          .map((m) => ({
            key: nextKey(),
            role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
            text: m.text ?? '',
            meta: m.role === 'assistant' ? m.model : null,
          })),
      )
    } catch (e) {
      appendError((e as Error).message)
    }
  }, [appendError])

  /* ── 选中会话：历史 + WS 订阅（断线每 3s 重连，接回后补历史/用量）── */
  useEffect(() => {
    if (sessionId === null) return
    setMsgs([])
    setStream('')
    setApproval(null)

    void loadHistory(sessionId)
    void loadUsage(sessionId)
    void loadModels(sessionId)

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
          if (data.type === 'assistant' && data.message !== undefined) {
            const text = textOf(data.message)
            if (text !== '') {
              setStream('')
              const model = (data.message as Record<string, unknown>).model
              appendMsg({ role: 'assistant', text, meta: typeof model === 'string' ? model : null })
            }
          } else if (data.type === 'user' && data.message !== undefined) {
            // 别的标签页发的也渲染；自己发的已乐观渲染 → 和上一条同文本就跳过
            const text = textOf(data.message)
            if (text !== '') {
              setMsgs((prev) => {
                const last = prev[prev.length - 1]
                if (last !== undefined && last.role === 'user' && last.text === text) return prev
                return [...prev, { key: nextKey(), role: 'user', text, meta: null }]
              })
            }
          } else if (data.type === 'result') {
            setStream('')
            void loadUsage(sessionId)
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
  }, [sessionId, appendMsg, appendError, loadHistory, loadUsage, loadModels])

  const selectSession = useCallback((id: string) => {
    setSessionId(id)
    history.replaceState(null, '', `?session=${id}`)
  }, [])

  const sendPrompt = useCallback(
    (text: string) => {
      if (sessionId === null) return
      appendMsg({ role: 'user', text, meta: null })
      post(`/api/v1/sessions/${sessionId}/prompt`, { text }).catch((e: Error) => appendError(e.message))
    },
    [sessionId, appendMsg, appendError],
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

  /* ── 新建会话 ── */
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

  const createSession = useCallback(
    (cwd: string) => {
      setShowNewDialog(false)
      post<{ session_id: string; cwd: string }>('/api/v1/sessions', { cwd })
        .then((d) => {
          // 乐观插入列表（jsonl 落盘前 /sessions 还看不到它）并选中
          setSessions((prev) => [
            {
              session_id: d.session_id,
              project_slug: '',
              cwd: d.cwd,
              first_message: null,
              mtime_ms: Date.now(),
            },
            ...prev,
          ])
          setSessionId(d.session_id)
          history.replaceState(null, '', `?session=${d.session_id}`)
        })
        .catch((e: Error) => appendError(e.message))
    },
    [appendError],
  )

  const active = sessions.find((s) => s.session_id === sessionId)

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        loading={sessionsLoading}
        activeId={sessionId}
        onSelect={selectSession}
        onNewSession={() => setShowNewDialog(true)}
      />
      <div className="main">
        <header className="topbar">
          <span className="topbar-title">{active !== undefined ? sessionTitle(active) : 'cc-web'}</span>
          <span className={`state-pill ${connected ? state : 'offline'}`}>
            <span className="dot" />
            {connected ? STATE_LABEL[state] : '已断线，重连中…'}
          </span>
          <select
            className="sel"
            disabled={sessionId === null}
            defaultValue=""
            onChange={(e) => {
              if (e.target.value !== '' && sessionId !== null) {
                post(`/api/v1/sessions/${sessionId}/model`, { model: e.target.value }).catch(
                  (err: Error) => appendError(err.message),
                )
              }
            }}
          >
            <option value="" disabled>模型</option>
            {models.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <select
            className="sel"
            disabled={sessionId === null}
            value={permMode}
            onChange={(e) => {
              setPermMode(e.target.value)
              if (sessionId !== null) {
                post(`/api/v1/sessions/${sessionId}/permission-mode`, { mode: e.target.value }).catch(
                  (err: Error) => appendError(err.message),
                )
              }
            }}
          >
            {PERMISSION_MODES.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          {usage !== '' && <span className="topbar-usage">{usage}</span>}
        </header>
        <Chat messages={msgs} streamText={stream} hasSession={sessionId !== null} />
        <Composer
          disabled={sessionId === null}
          running={state !== 'idle'}
          onSend={sendPrompt}
          onInterrupt={interrupt}
        />
      </div>
      {approval !== null && <ApprovalDialog approval={approval} onDecide={decideApproval} />}
      {showNewDialog && (
        <NewSessionDialog
          projects={projects}
          defaultCwd={active?.cwd ?? null}
          onCancel={() => setShowNewDialog(false)}
          onCreate={createSession}
        />
      )}
    </div>
  )
}
