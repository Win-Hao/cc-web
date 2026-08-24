/**
 * M3：HTTP 只读接口（Hono）。
 *
 * 信封约定（API.md）：所有 JSON 响应 { code, msg, data, trace_id }，
 * 业务结果看 code（0 = 成功），HTTP 状态码只表达传输层 —— 「会话不存在」
 * 也是 HTTP 200 + code !== 0。字段叫 trace_id 不叫 request_id，
 * 后者是 CC 控制协议里审批请求的 id，撞名必混。
 */
import { Hono } from 'hono'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expandHome } from '#/sessions/slug.js'
import { listSessions } from '#/sessions/list.js'
import { findSessionFile } from '#/sessions/find.js'
import { parseSessionFile } from '#/sessions/parse.js'
import { aggregateSessionUsage } from '#/usage/aggregate.js'
import { findSubagentFile, listSubagents } from '#/sessions/subagents.js'
import { normalizeMessage, paginate } from './history.js'
import { SessionBusyError, ControlRequestError, ApprovalExpiredError } from './registry.js'
import type { PromptImage, SessionRegistry } from './registry.js'
import { bearerAuth } from '#/auth/middleware.js'

export interface AppDeps {
  /** ~/.claude/projects 的根（测试注入 fixture 目录） */
  projectsRoot: string
  /** M5+：prompt / interrupt 等写操作需要；只读服务器可以不传 */
  registry?: SessionRegistry
  /** M8：传了就对 /api/v1/* 强制 bearer 鉴权；不传是测试形态 */
  token?: string
  /** M35：套餐额度缓存的过期阈值（测试注入 0 验证后台刷新） */
  planTtlMs?: number
  /** React 前端的构建产物目录（vite build 的 dist/web）；测试注入临时目录 */
  webRoot?: string
}

const HISTORY_DEFAULT_LIMIT = 50
const HISTORY_MAX_LIMIT = 200

/** prompt 图片校验（M43）：Messages API 支持的四种位图 + 5MB 上限 */
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_IMAGE_DATA = 7_000_000 // base64 字符数 ≈ 5MB 原始数据（API 单图上限）
const MAX_IMAGES = 8

/** 合法 → PromptImage[]（可为空）；形状/类型/大小/数量任一不合法 → null */
function parsePromptImages(v: unknown): PromptImage[] | null {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > MAX_IMAGES) return null
  const out: PromptImage[] = []
  for (const item of v) {
    if (typeof item !== 'object' || item === null) return null
    const img = item as Record<string, unknown>
    if (typeof img.media_type !== 'string' || !IMAGE_MEDIA_TYPES.has(img.media_type)) return null
    if (typeof img.data !== 'string' || img.data === '' || img.data.length > MAX_IMAGE_DATA) return null
    out.push({ media_type: img.media_type, data: img.data })
  }
  return out
}

function ok(data: unknown) {
  return { code: 0, msg: 'success', data, trace_id: randomUUID() }
}

function fail(code: number, msg: string) {
  return { code, msg, data: null, trace_id: randomUUID() }
}

/** 占位 UI（D2）：没跑过 `pnpm build:web` 时的兜底，保证开箱能用 */
const WEB_INDEX = fileURLToPath(new URL('../web/index.html', import.meta.url))
/** React 前端产物的默认位置（<repo>/dist/web） */
const WEB_DIST = fileURLToPath(new URL('../../dist/web', import.meta.url))

const ASSET_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

export function createApp(deps: AppDeps) {
  const app = new Hono()

  if (deps.token !== undefined) app.use('/api/v1/*', bearerAuth(deps.token))

  // 静态页不需要鉴权（数据全走带 token 的 API/WS）。
  // 优先 React 构建产物（pnpm build:web → dist/web），没有就回退占位 UI。
  const webRoot = deps.webRoot ?? WEB_DIST
  app.get('/', (c) => {
    const built = join(webRoot, 'index.html')
    return c.html(readFileSync(existsSync(built) ? built : WEB_INDEX, 'utf8'))
  })
  app.get('/assets/:name', (c) => {
    const name = c.req.param('name')
    // 白名单文件名（vite 产物只有 [word.-] 字符），路由参数本身不含 '/'，
    // 双保险挡路径穿越
    if (!/^[\w.-]+$/.test(name) || name.includes('..')) return c.notFound()
    const file = join(webRoot, 'assets', name)
    if (!existsSync(file)) return c.notFound()
    const ext = name.slice(name.lastIndexOf('.'))
    const type = ASSET_TYPES[ext] ?? 'application/octet-stream'
    return c.body(readFileSync(file), 200, { 'content-type': `${type}; charset=utf-8` })
  })

  app.get('/api/v1/meta', (c) =>
    // home：前端把绝对路径缩写成 ~/…（M22 目录选择器）
    c.json(ok({ name: 'cc-web', version: '0.0.0', home: homedir() })),
  )

  /**
   * M22：目录浏览（草稿态「选择文件夹…」的下钻）。只列目录名，
   * 隐藏目录不出，读不了（权限/不存在/不是目录）→ 信封错误码。
   */
  app.get('/api/v1/fs/dirs', async (c) => {
    const raw = c.req.query('path') ?? '~'
    const path = expandHome(raw.trim() === '' ? '~' : raw.trim())
    if (!path.startsWith('/')) return c.json(fail(40006, 'path must be absolute or ~'))
    try {
      const entries = await readdir(path, { withFileTypes: true })
      const names = entries.filter((e) => e.isDirectory()).map((e) => e.name)
      // 普通目录在前、隐藏目录在后（.claude 这类也要能选到）
      const dirs = [
        ...names.filter((n) => !n.startsWith('.')).sort((a, b) => a.localeCompare(b)),
        ...names.filter((n) => n.startsWith('.')).sort((a, b) => a.localeCompare(b)),
      ].slice(0, 500)
      return c.json(ok({ path, dirs }))
    } catch {
      return c.json(fail(40005, `cannot read directory: ${path}`))
    }
  })

  /**
   * M29：账户级模型/设置元数据。不借任何真实会话（--resume 大会话要先
   * 加载整个转写，冷启动会超握手超时）——起一次性空白引擎（--session-id
   * 新会话，无转写秒起），拉完 list_models + get_settings 就停掉，结果
   * 进程内缓存。不发消息就不会落盘 jsonl，不留垃圾会话。
   */
  interface MetaInfo {
    models: unknown
    settings: unknown
    /** 默认模型的 context 窗口（get_context_usage.maxTokens）—— 降级估算用 */
    contextWindow: number | null
  }
  let metaCache: MetaInfo | null = null
  let metaInflight: Promise<MetaInfo> | null = null
  /** 套餐额度缓存（M34）：元数据引擎顺带拉，之后借活引擎按需刷新 */
  let planCache: { payload: unknown; fetched_at: number } | null = null
  let planRefreshing = false
  const planTtlMs = deps.planTtlMs ?? 5 * 60_000

  /** 后台刷新套餐额度（M36）：单飞；优先借活引擎，没有就空白引擎拿完即停 */
  function refreshPlanCache(registry: SessionRegistry): void {
    if (planRefreshing) return
    planRefreshing = true
    void (async () => {
      const live = registry.liveSessionIds()[0]
      const id = live ?? (await registry.create(homedir()))
      try {
        const payload = await registry.getUsage(id)
        if (payload !== null) planCache = { payload, fetched_at: Date.now() }
      } finally {
        if (live === undefined) void registry.get(id)?.stop()
      }
    })()
      .catch(() => {})
      .finally(() => {
        planRefreshing = false
      })
  }

  async function ensureMeta(registry: SessionRegistry): Promise<MetaInfo> {
    if (metaCache !== null) return metaCache
    if (metaInflight === null) {
      metaInflight = (async () => {
        const id = await registry.create(homedir())
        try {
          const modelsPayload = (await registry.listModels(id)) as { models?: unknown } | null
          const settings = await registry.getSettings(id).catch(() => null)
          const ctx = (await registry.getContextUsage(id)) as { maxTokens?: number } | null
          // 顺手把套餐额度也拉了（M34）：面板秒开，永不为它额外起引擎
          const usage = await registry.getUsage(id)
          if (usage !== null) planCache = { payload: usage, fetched_at: Date.now() }
          return {
            models: modelsPayload?.models ?? [],
            settings,
            contextWindow: typeof ctx?.maxTokens === 'number' ? ctx.maxTokens : null,
          }
        } finally {
          void registry.get(id)?.stop()
        }
      })().finally(() => {
        metaInflight = null
      })
    }
    metaCache = await metaInflight
    return metaCache
  }

  app.get('/api/v1/models', async (c) => {
    if (deps.registry === undefined) return c.json(fail(50001, 'registry not configured'))
    try {
      return c.json(ok(await ensureMeta(deps.registry)))
    } catch (err) {
      return c.json(controlFail(err))
    }
  })

  app.get('/api/v1/sessions', async (c) => {
    const sessions = await listSessions(deps.projectsRoot)
    return c.json(ok({ sessions }))
  })

  /** M12：新建会话。cwd 必须是存在的目录；session id 由服务器发（--session-id）。 */
  app.post('/api/v1/sessions', async (c) => {
    if (deps.registry === undefined) return c.json(fail(50001, 'registry not configured'))
    const body: unknown = await c.req.json().catch(() => null)
    const cwdRaw =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).cwd
        : null
    if (typeof cwdRaw !== 'string' || cwdRaw.trim() === '') {
      return c.json(fail(40001, 'cwd required'))
    }
    const cwd = expandHome(cwdRaw.trim())
    const st = await stat(cwd).catch(() => null)
    if (st === null || !st.isDirectory()) {
      return c.json(fail(40004, `not an existing directory: ${cwd}`))
    }
    try {
      const sessionId = await deps.registry.create(cwd)
      return c.json(ok({ session_id: sessionId, cwd }))
    } catch (err) {
      return c.json(fail(50002, err instanceof Error ? err.message : 'failed to create session'))
    }
  })

  app.get('/api/v1/sessions/:id/history', async (c) => {
    const file = await findSessionFile(deps.projectsRoot, c.req.param('id'))
    if (file === null) {
      // 新建的会话在首条消息前没有 jsonl：引擎活着就回空页，不算 404
      if (deps.registry?.get(c.req.param('id')) !== undefined) {
        return c.json(ok({ messages: [], has_more: false }))
      }
      return c.json(fail(40401, 'session not found'))
    }

    const parsed = await parseSessionFile(file)
    const limitRaw = Number(c.req.query('limit') ?? HISTORY_DEFAULT_LIMIT)
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.floor(limitRaw), HISTORY_MAX_LIMIT)
        : HISTORY_DEFAULT_LIMIT
    const beforeRaw = c.req.query('before')
    const before = beforeRaw === undefined ? undefined : Number(beforeRaw)

    const page = paginate(parsed.mainline, {
      limit,
      ...(before !== undefined && Number.isFinite(before) ? { before } : {}),
    })
    // M17：主线消息若是 subagent 的锚点，带上计数 —— 前端据此显示
    // 「子代理 · N 条」，点开再拉 /sidechains/:uuid
    const messages = page.messages.map((m) => {
      const count = m.uuid !== null ? (parsed.sidechains[m.uuid]?.length ?? 0) : 0
      return count > 0 ? { ...m, sidechain_count: count } : m
    })
    return c.json(ok({ ...page, messages }))
  })

  /** M17（新格式）：会话的 subagent 列表 —— toolUseId 锚到工具行 */
  app.get('/api/v1/sessions/:id/subagents', async (c) => {
    const file = await findSessionFile(deps.projectsRoot, c.req.param('id'))
    if (file === null) return c.json(ok({ agents: [] })) // 新会话还没落盘也别报错
    return c.json(ok({ agents: await listSubagents(file) }))
  })

  /** M17（新格式）：单个 subagent 的转写，形状同 history 的 messages */
  app.get('/api/v1/sessions/:id/subagents/:agentId', async (c) => {
    const file = await findSessionFile(deps.projectsRoot, c.req.param('id'))
    if (file === null) return c.json(fail(40401, 'session not found'))
    const agentFile = await findSubagentFile(file, c.req.param('agentId'))
    if (agentFile === null) return c.json(ok({ messages: [] }))
    const parsed = await parseSessionFile(agentFile)
    // agent 文件里全是 isSidechain 行，mainline 为空 —— 按行序给 entries
    const messages = parsed.entries
      .filter((e) => e.type === 'user' || e.type === 'assistant')
      .map(normalizeMessage)
    return c.json(ok({ messages }))
  })

  /** M17（旧格式）：某条主线消息锚定的 subagent 消息（R8 的分组），形状同 history */
  app.get('/api/v1/sessions/:id/sidechains/:uuid', async (c) => {
    const file = await findSessionFile(deps.projectsRoot, c.req.param('id'))
    if (file === null) return c.json(fail(40401, 'session not found'))
    const uuid = c.req.param('uuid')
    if (!/^[a-zA-Z0-9-]+$/.test(uuid)) return c.json(ok({ messages: [] }))
    const parsed = await parseSessionFile(file)
    const group = parsed.sidechains[uuid] ?? []
    return c.json(ok({ messages: group.map(normalizeMessage) }))
  })

  app.post('/api/v1/sessions/:id/prompt', async (c) => {
    if (deps.registry === undefined) return c.json(fail(50001, 'registry not configured'))
    const body: unknown = await c.req.json().catch(() => null)
    const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
    const text = typeof b.text === 'string' ? b.text : ''
    const images = parsePromptImages(b.images)
    if (images === null) return c.json(fail(40001, 'invalid images'))
    if (text === '' && images.length === 0) return c.json(fail(40001, 'text required'))
    try {
      await deps.registry.prompt(c.req.param('id'), text, images)
      return c.json(ok({}))
    } catch (err) {
      if (err instanceof SessionBusyError) {
        return c.json(fail(40901, 'session busy: running or waiting-approval'))
      }
      throw err
    }
  })

  app.post('/api/v1/sessions/:id/interrupt', async (c) => {
    // 会话没在跑也不算错（TDD M5）：registry 内部静默跳过
    await deps.registry?.interrupt(c.req.param('id'))
    return c.json(ok({}))
  })

  /** M6 控制类路由的公共错误处理：ControlRequestError → 信封错误码，HTTP 仍 200 */
  function controlFail(err: unknown) {
    if (err instanceof ControlRequestError) return fail(50201, err.message)
    throw err
  }

  app.post('/api/v1/sessions/:id/model', async (c) => {
    if (deps.registry === undefined) return c.json(fail(50001, 'registry not configured'))
    const body: unknown = await c.req.json().catch(() => null)
    const model =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).model
        : null
    if (typeof model !== 'string' || model === '') return c.json(fail(40001, 'model required'))
    try {
      await deps.registry.setModel(c.req.param('id'), model)
      return c.json(ok({}))
    } catch (err) {
      return c.json(controlFail(err))
    }
  })

  app.post('/api/v1/sessions/:id/permission-mode', async (c) => {
    if (deps.registry === undefined) return c.json(fail(50001, 'registry not configured'))
    const body: unknown = await c.req.json().catch(() => null)
    const mode =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).mode
        : null
    if (typeof mode !== 'string' || mode === '') return c.json(fail(40002, 'mode required'))
    try {
      await deps.registry.setPermissionMode(c.req.param('id'), mode)
      return c.json(ok({}))
    } catch (err) {
      return c.json(controlFail(err))
    }
  })

  /** M24：思考程度（effort）。apply_flag_settings 的 effortLevel 通道。 */
  app.post('/api/v1/sessions/:id/effort', async (c) => {
    if (deps.registry === undefined) return c.json(fail(50001, 'registry not configured'))
    const body: unknown = await c.req.json().catch(() => null)
    const effort =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).effort
        : null
    if (typeof effort !== 'string' || effort === '') return c.json(fail(40001, 'effort required'))
    try {
      await deps.registry.applyFlagSettings(c.req.param('id'), { effortLevel: effort })
      return c.json(ok({}))
    } catch (err) {
      return c.json(controlFail(err))
    }
  })

  /** M27：会话设置（applied.effort/model 给前端当默认值）。 */
  app.get('/api/v1/sessions/:id/settings', async (c) => {
    if (deps.registry === undefined) return c.json(fail(50001, 'registry not configured'))
    try {
      return c.json(ok((await deps.registry.getSettings(c.req.param('id'))) ?? {}))
    } catch (err) {
      return c.json(controlFail(err))
    }
  })

  app.get('/api/v1/sessions/:id/models', async (c) => {
    if (deps.registry === undefined) return c.json(fail(50001, 'registry not configured'))
    try {
      // list_models 的 response payload（含 models），响应体可能缺省
      const payload = (await deps.registry.listModels(c.req.param('id'))) ?? {}
      return c.json(ok(payload))
    } catch (err) {
      return c.json(controlFail(err))
    }
  })

  app.post('/api/v1/sessions/:id/approvals/:requestId', async (c) => {
    if (deps.registry === undefined) return c.json(fail(50001, 'registry not configured'))
    const body: unknown = await c.req.json().catch(() => null)
    const behavior =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).behavior
        : null
    if (behavior !== 'allow' && behavior !== 'deny') {
      return c.json(fail(40003, 'behavior must be "allow" or "deny"'))
    }
    const message =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).message
        : undefined
    // AskUserQuestion 等交互工具：allow 时带 updatedInput 把答案塞回入参
    const updatedInput =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).updatedInput
        : undefined
    const decision =
      behavior === 'allow'
        ? typeof updatedInput === 'object' && updatedInput !== null
          ? ({ behavior: 'allow', updatedInput: updatedInput as Record<string, unknown> } as const)
          : ({ behavior: 'allow' } as const)
        : ({
            behavior: 'deny',
            message: typeof message === 'string' ? message : 'denied by user',
          } as const)
    try {
      deps.registry.answerApproval(c.req.param('id'), c.req.param('requestId'), decision)
      return c.json(ok({}))
    } catch (err) {
      // 已答复 / 已超时 / 已取消 / 不存在 → 「已过期」错误码，不崩（R2）
      if (err instanceof ApprovalExpiredError) return c.json(fail(41001, err.message))
      throw err
    }
  })

  /* ── M9：用量（get_usage，D5 可降级）────────────────────── */

  app.get('/api/v1/sessions/:id/usage', async (c) => {
    const id = c.req.param('id')
    // 引擎活着走 get_usage（含官方成本）；拿不到或引擎已回收 → jsonl 聚合
    if (deps.registry?.get(id) !== undefined) {
      const payload = await deps.registry.getUsage(id)
      if (typeof payload === 'object' && payload !== null) {
        // 顺手刷新套餐额度缓存（M36）：每轮对话结束都会走到这里，
        // 面板数据新鲜度因此 = 最近一轮，零额外请求
        if ((payload as Record<string, unknown>).rate_limits != null) {
          planCache = { payload, fetched_at: Date.now() }
        }
        const session = (payload as Record<string, unknown>).session
        if (typeof session === 'object' && session !== null) return c.json(ok(session))
      }
    }
    const file = await findSessionFile(deps.projectsRoot, id)
    if (file === null) return c.json(ok(null))
    const parsed = await parseSessionFile(file)
    const usage = aggregateSessionUsage(parsed)
    // 形状对齐 get_usage 的 session 段：total_cost_usd + model_usage。
    // jsonl 没有官方成本 → null（D5：token 量有，成本没有，形状不变）
    return c.json(
      ok({
        total_cost_usd: null,
        model_usage: usage.model_usage,
        total: usage.total,
      }),
    )
  })

  /**
   * M30/M31：context 窗口用量。引擎活着走 get_context_usage（精确）；
   * 引擎不在（打开历史会话）降级为 jsonl 末轮 usage 估算，窗口大小取
   * 元数据引擎的 maxTokens（默认模型的真实窗口），标注 estimated。
   * 会话级路由不为看环 spawn 进程（元数据引擎全服务器只此一个）。
   */
  app.get('/api/v1/sessions/:id/context', async (c) => {
    const id = c.req.param('id')
    if (deps.registry === undefined) return c.json(ok(null))
    if (deps.registry.get(id) !== undefined) {
      const payload = await deps.registry.getContextUsage(id)
      if (typeof payload === 'object' && payload !== null) {
        const p = payload as Record<string, unknown>
        return c.json(
          ok({
            total_tokens: p.totalTokens ?? null,
            max_tokens: p.maxTokens ?? null,
            percentage: p.percentage ?? null,
            estimated: false,
          }),
        )
      }
      return c.json(ok(null))
    }
    // 降级：jsonl 末轮 usage（上一轮结束时在窗口里的量 ≈ input+cache+output）
    const file = await findSessionFile(deps.projectsRoot, id)
    if (file === null) return c.json(ok(null))
    const parsed = await parseSessionFile(file)
    let tokens: number | null = null
    for (let i = parsed.mainline.length - 1; i >= 0; i--) {
      const u = parsed.mainline[i]!.usage
      if (u !== null) {
        tokens =
          (u.input_tokens ?? 0) +
          (u.output_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0)
        break
      }
    }
    if (tokens === null) return c.json(ok(null))
    let window: number | null = null
    try {
      window = (await ensureMeta(deps.registry)).contextWindow
    } catch {
      window = null
    }
    if (window === null || window <= 0) return c.json(ok(null))
    return c.json(
      ok({
        total_tokens: tokens,
        max_tokens: window,
        percentage: (tokens / window) * 100,
        estimated: true,
      }),
    )
  })

  /**
   * M32/M34：账户级套餐用量（底部菜单的面板）。额度数据只有持凭证的
   * CC 进程能查（不落盘，实测），但绝不为它额外起引擎：
   *   1. 元数据引擎启动时顺带拉一次进缓存（页面加载即预热）
   *   2. 缓存过期（5min）且恰有活引擎 → 借它刷新
   *   3. 其余情况直接给缓存（带 fetched_at，前端标注数据时间）
   */
  app.get('/api/v1/plan-usage', async (c) => {
    const registry = deps.registry
    if (registry === undefined) return c.json(ok(null))
    const trim = (payload: unknown) => {
      const p = payload as Record<string, unknown>
      return {
        rate_limits_available: p.rate_limits_available !== false,
        rate_limits: p.rate_limits ?? null,
        subscription_type: p.subscription_type ?? null,
        fetched_at: planCache?.fetched_at ?? Date.now(),
      }
    }
    // SWR（M35）：有缓存就立即返回 —— get_usage 要出网问 Anthropic（秒级），
    // 绝不让面板等它。过期且有活引擎 → 后台刷新，下次打开就是新的。
    if (planCache !== null) {
      if (Date.now() - planCache.fetched_at > planTtlMs) refreshPlanCache(registry)
      return c.json(ok(trim(planCache.payload)))
    }
    // 真·冷启动（页面加载的预热还没完成）：等元数据引擎那一次
    await ensureMeta(registry).catch(() => null)
    // ensureMeta 内部会填 planCache；TS 的控制流分析跟不上闭包赋值，重取一次
    const filled = planCache as { payload: unknown; fetched_at: number } | null
    if (filled === null) return c.json(ok(null))
    return c.json(ok(trim(filled.payload)))
  })

  app.get('/api/v1/usage', async (c) => {
    // 订阅额度是账户级的，但 get_usage 要走某个会话的引擎 ——
    // 调用方用 ?session=<id> 指定；没有就没法拿，回 null（不显示，不报错）
    const sessionId = c.req.query('session')
    if (sessionId === undefined || sessionId === '' || deps.registry === undefined) {
      return c.json(ok(null))
    }
    // 只查已有活引擎的会话 —— 用量是锦上添花，绝不为它 spawn 引擎（D5）。
    // 没有这个守卫，前端每切一个会话就会拉起一个 claude 进程。
    if (deps.registry.get(sessionId) === undefined) return c.json(ok(null))
    const payload = await deps.registry.getUsage(sessionId)
    if (typeof payload !== 'object' || payload === null) return c.json(ok(null))
    const p = payload as Record<string, unknown>
    // rate_limits_available: false 是正常情况（API key / Bedrock / Vertex），
    // 返回 null + code 0，UI 优雅不显示（D5/R4）
    if (p.rate_limits_available === false) return c.json(ok(null))
    return c.json(ok(p.rate_limits ?? null))
  })

  return app
}
