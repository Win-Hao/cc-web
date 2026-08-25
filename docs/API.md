# HTTP / WebSocket 接口

接口形状：统一信封、`/api/v1` 前缀、bearer token。
沿用的理由是省决策成本，不是它有多好——但它确实经过了实战。

## 统一信封

所有 JSON 响应：

```json
{ "code": 0, "msg": "success", "data": {}, "trace_id": "..." }
```

**业务结果看 `code`（0 = 成功），HTTP 状态码只表达传输层。**
这点跟 REST 原教旨不一样，但好处是前端只有一个分支要写。

字段叫 `trace_id` 不叫 `request_id`——后者是 CC 控制协议里审批请求的
id（见下面 `approval` 事件），两个撞名，实现时必混。

## 鉴权

- REST：`Authorization: Bearer <token>`
- WebSocket：能自定义头就用 `Authorization`；浏览器不能，
  改用子协议 `cc-web.bearer.<token>`
- 浏览器首次进入：URL 带 `#token=<token>` fragment，前端读完存起来
- token 用 hex / base64url 生成——WS 子协议只接受 RFC6455 token 字符，
  标准 base64 的 `+` `/` `=` 会出问题

## REST

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/meta` | 服务器版本、CC 版本、健康检查 |
| GET | `/api/v1/sessions` | 会话列表（扫 `~/.claude/projects/`） |
| GET | `/api/v1/sessions/search` | **全文搜索**：`?q=<词>&limit=N`（q ≥2 字符）。按 mtime 新→旧扫、拿够即停；返回 `hits[]`（session + snippet + match_count）。注册必须在 `/sessions/:id` 之前 |
| POST | `/api/v1/sessions` | 新建会话：`{cwd}` → `{session_id}`（服务器发 uuid，引擎走 `--session-id`） |
| POST | `/api/v1/sessions` | 新建会话，body 带 `cwd`。服务器生成 uuid 用 `--session-id` 传入，响应同步返回 session id |
| GET | `/api/v1/sessions/:id` | 会话元信息：cwd、模型、权限模式、状态 |
| GET | `/api/v1/sessions/:id/history` | 历史消息（D7：归一化后的 Message，tool_result 已配对进 tool_use 块，bookkeeping 行不出）。**cursor 分页**：`?limit=N&before=<cursor>`，响应带 `has_more`（R9：jsonl 是 append-only，用 cursor 不用 offset） |
| GET | `/api/v1/sessions/:id/usage` | 本会话 token / 成本聚合 |
| POST | `/api/v1/sessions/:id/prompt` | 发提示词。body `{text, images?}`；images 为 `{media_type, data(base64)}[]`，四种位图、单张 ≤5MB、最多 8 张，有图时 text 可空。并发策略见 R7：运行中拒绝；waiting-approval 也拒绝 |
| POST | `/api/v1/sessions/:id/interrupt` | 中断（→ `interrupt`） |
| POST | `/api/v1/sessions/:id/model` | 切模型（→ `set_model`） |
| POST | `/api/v1/sessions/:id/permission-mode` | 切权限模式 |
| POST | `/api/v1/sessions/:id/approvals/:requestId` | **回工具审批**。已答复 / 已超时 → 返回「已过期」错误码，不崩 |
| GET | `/api/v1/sessions/:id/models` | 可用模型列表（← `list_models`） |
| GET | `/api/v1/usage` | 订阅额度，**可能返回 `null`** |

**对 idle 会话的控制请求会按需拉起引擎**：prompt / model / permission-mode /
interrupt / approvals 打到引擎已回收的会话时，服务器先 spawn + initialize
再发控制帧。调用方不感知，但首个请求会慢几秒。

`GET /api/v1/usage` 返回 `null` 是**正常情况**，不是错误——
API key / Bedrock / Vertex 用户本来就没有订阅额度
（`rate_limits_available: false`）。前端必须处理这个 null。

额度数据来自 `get_usage` 控制请求，形状见 `docs/PROTOCOL.md` §4：
`five_hour` / `seven_day` / `seven_day_opus` …，每个带
`utilization`（0-100）和 `resets_at`（ISO 8601）。

`/sessions/:id/usage` 有两个数据源，对前端透明：引擎活着走 `get_usage`
（含官方成本），引擎已回收降级到 jsonl 聚合（只有 token 量）。
接口形状一致，来源差异不外泄。

## WebSocket

`/api/v1/ws`，服务器推事件：

| 事件 | 时机 |
| --- | --- |
| `message` | 一条归一化后的 Message（与 /history 同形，D7）。**按 `key` upsert**：占位（`partial: true`，key = `<message.id>:<index>` 或 `prompt:<n>`）先到，最终消息带 `replaces` 换掉它；tool_result 到了同一 key 再发一次（tool_use 块的 status / result 变了） |
| `delta` | `{key, kind: text \| thinking, chunk}`，追加到对应占位的块上（靠 `--include-partial-messages`，见 PROTOCOL §1） |
| `turn_end` | 回合结束：`{duration_ms, output_tokens, cost_usd}`（来自 result 帧） |
| `state` | 状态变化：`{state: idle / running / waiting-approval, model, permission_mode}`（后两项来自 init 帧，没握过手是 null） |
| `approval` | **CC 要审批**，带 `requestId` + 工具名 + 入参 |
| `approval_resolved` | 审批终态：allow / deny / 超时 / 被取消，带 `requestId`——所有标签页同步关弹框 |
| `rate_limit` | 额度变化推送（← `rate_limit_event`），**不用轮询** |
| `error` | 出错 |

**断线补发**：所有事件带 session 级单调递增 `seq`，服务器为每个
session 保留滚动 buffer（最近 N 条）。重连带 `?since=<seq>` 补发缺口。
**不带 `since` = 新打开的页面**：不回放（上一回合的 message 回放是幂等的，
delta 不是），改为在 state 之后直发当前回合的快照（`seq: 0`，占位消息带
已累积的文本）——刷新页面不丢正在流的那半截输出，`/history` 补不上它
（jsonl 落盘有延迟）。浏览器不把 seq 0 记进游标。

`approval` 事件是整个设计里最要紧的一条：前端收到就弹确认框，
用户点了之后 POST 回 `/approvals/:requestId`。
**用户不点，引擎就一直等**——所以要有超时（见 RISKS R2）。
另外同一个 `requestId` 可能到达两次（`initialize` 的
`pending_permission_requests` + 实时帧），服务器在引擎层按 `requestId`
去重（D8），**前端也要容忍重复**，见 RISKS R5。

## 端口

默认 `58630`。被占用则 +1 重试。
