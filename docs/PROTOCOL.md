# CC 对外的接口面

> **读法**：✅ = 在本机 `claude 2.1.241` / SDK `0.3.241` 上实际验证过；
> ❓ = 存在但**运行时形状没验证**，要用 probe 测试钉死。

## 0. 事实来源：SDK 的 .d.ts ⭐

```sh
pnpm add -D @anthropic-ai/claude-agent-sdk
# node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
```

**这是整个项目最重要的一个文件。** 它有完整的类型定义：消息联合体
`SDKMessage`、控制请求 `SDKControlRequest`、每一种响应的形状。

运行时**不引入** SDK（我们自己 spawn CLI，见 D1），只吃它的类型。
引擎的事件类型应该从 `SDKMessage` 派生，别手写——手写的一定会漏。

`SDKMessage` 有 40+ 个成员，除了常规的 assistant/user/result 还有
`SDKRateLimitEvent`、`SDKThinkingTokensMessage`、`SDKToolProgressMessage`、
`SDKCompactBoundaryMessage` 等等。先读一遍再动手。

## 1. 启动引擎 ✅

```sh
claude -p --verbose \
  --input-format stream-json \
  --output-format stream-json \
  --include-partial-messages \
  --resume <session-id>
```

| flag | 用途 |
| --- | --- |
| `-p, --print` | 非交互，stream-json 的前提 |
| `--verbose` | **必须**。`-p` + `--output-format stream-json` 缺它直接报错（2.1.241 实测：`requires --verbose`） |
| `--input-format stream-json` | 实时流式输入 |
| `--output-format stream-json` | 实时流式输出 |
| `--include-partial-messages` | 流式增量帧。WS 的 `delta` 事件靠它；不加只有完整消息，没有「打字机」效果 |
| `--replay-user-messages` | 把收到的 stdin 回显到 stdout 确认（可选，调试好用） |
| `-r, --resume <id>` | 按 session id 续接 |
| `--session-id <uuid>` | 指定新会话 id（必须合法 UUID） |
| `--fork-session` | resume 时另开新 id |
| `--model` | 初始模型（切换用控制协议） |

## 2. 会话文件 ✅

```
~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl
```

`<cwd-slug>` = 工作目录路径把 `/` 换成 `-`。
例：`/Users/x/vibe-coding/my-app` → `-Users-x-vibe-coding-my-app`

assistant 行的顶层键（实测）：

```
parentUuid  isSidechain  message  requestId  type  uuid  timestamp
effort  session_id  userType  entrypoint  cwd  sessionId  version  gitBranch
```

`message.usage` 实测样本：

```json
{
  "input_tokens": 2,
  "cache_creation_input_tokens": 1621,
  "cache_read_input_tokens": 68388,
  "output_tokens": 999,
  "output_tokens_details": { "thinking_tokens": 559 },
  "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
  "service_tier": "standard",
  "cache_creation": {
    "ephemeral_1h_input_tokens": 1621,
    "ephemeral_5m_input_tokens": 0
  }
}
```

`message.model` 在同一条上（例：`claude-opus-5`）。

注意 `parentUuid` 构成消息树，`isSidechain: true` 是 subagent 的消息——
渲染时要分开，否则 Task 跑起来时主线会混进一堆看不懂的对话。

**subagent 的两种落盘格式**（M17 实测，基线 2.1.241）：

- 旧格式：subagent 行混在主 jsonl 里（`isSidechain: true`，沿 `parentUuid`
  锚到主线消息）。`parse.ts` 的 `sidechains` 按锚点 uuid 分组。
- 新格式（2.1.241 本机实测）：主 jsonl 里 **没有** sidechain 行，subagent
  转写独立存放：

  ```
  <slug>/<sessionId>/subagents/agent-<agentId>.jsonl       # 行结构同主转写，isSidechain: true
  <slug>/<sessionId>/subagents/agent-<agentId>.meta.json   # 锚定关系在这
  ```

  meta.json：`{agentType, description, toolUseId, parentAgentId, spawnDepth}` ——
  `toolUseId` 对应主转写里 Task/Agent 调用的 `tool_use.id`，这是唯一的锚。
  实时流里对应帧的顶层 `parent_tool_use_id` 同 id。两种格式都要支持。

**会话标题**（M20 实测，2.1.241）：jsonl 里没有 summary/title 行；
TUI 显示的生成名只存在进程级注册表（`~/.claude/sessions/<pid>.json` 的
`name`，进程退出即失效），headless 会话拿不到。所以列表/顶栏的标题
只能取首条人话消息，每轮 result 后刷新一次列表跟随。

每行还带 `cwd`：**resume 时引擎 spawn 的 `cwd` 必须设成它**，
否则 CLAUDE.md、相对路径、git 上下文全错。新建会话则是用户指定的目录。

**thinking / image 块的落盘形状**（M42 实测，2026-08）：

- assistant 行 content 里的 thinking 块：`{type:'thinking', thinking, signature}`。
  **`thinking` 可能是空串**（部分模型/配置落盘时脱敏，只留 signature）——
  渲染方必须跳过空串，否则出一排空折叠块。同一台机器上有的会话有全文、
  有的全空，按会话为单位。
- 图片统一是 `{type:'image', source:{type:'base64', media_type, data}}`，
  出现在三个位置：用户消息 content（粘贴图）、tool_result 的 content 数组
  （截图类工具）、subagent 转写。实测单图 base64 约 300KB 量级；
  server 历史接口透传上限 2.8M 字符（≈2MB），超限降级占位文本。
- 实时流的 thinking 增量：`stream_event` 的 `content_block_delta` 帧，
  `delta.type === 'thinking_delta'`，字段是 `delta.thinking`（不是 text）。

**stdin 的 user 帧接受 image 块**（M43 真机实测，2026-08）：
`{type:'user', message:{role:'user', content:[{type:'image', source:{type:'base64',
media_type, data}}, {type:'text', text}]}}` —— 引擎正确识图（发红色 PNG 问
颜色，回答「红色」）。纯图无文字也接受。这与 sdk.d.ts 的 SDKUserMessage
注释一致（content 支持 text/image/document/tool_result 块）。

**set_permission_mode 的 bypass 门槛**（M19 实测，基线 2.1.241）：
运行时切到 `bypassPermissions` 要求进程启动时带
`--allow-dangerously-skip-permissions`（把 bypass 变成可选项，默认行为
不变）；不带则对端回 error「session was not launched with
--dangerously-skip-permissions」。引擎默认带上（cli.ts STREAM_ARGS）。

## 3. 控制协议 ✅（类型）❓（运行时）

`SDKControlRequest` 的 envelope：

```ts
{ type: 'control_request', request_id: string, request: SDKControlRequestInner }
```

`SDKControlRequestInner` 有 30+ 个成员。**我们要用的**：

| subtype | 用途 | 方向 |
| --- | --- | --- |
| `set_model` | 切模型，不重启进程、不丢会话 | 我们 → CC |
| `list_models` | **列出可用模型** | 我们 → CC |
| `set_permission_mode` | 切权限模式 | 我们 → CC |
| `interrupt` | 中断当前轮次 | 我们 → CC |
| `get_usage` | **用量 + 订阅额度**，见 §4 | 我们 → CC |
| `get_session_cost` | 本会话成本 | 我们 → CC |
| `get_context_usage` | 上下文占用 | 我们 → CC |
| `can_use_tool` | **工具审批** | **CC → 我们** |
| `hook_callback` | hook 回调 | CC → 我们 |
| `initialize` | 握手 | 我们 → CC |

`list_models` 是意外之喜：模型下拉框可以从 CC 拿，不用硬编码，
CC 更新模型列表时前端自动跟上。

其它值得知道但暂时不用的：`rewind_files`、`stop_task`、
`background_tasks`、`reload_plugins`、`reload_skills`、`mcp_*`、
`request_user_dialog`、`elicitation`。

### 两个必须处理的边角

1. **`initialize` 响应里带 `pending_permission_requests`**。
   一个客户端接入已经初始化的会话时，会拿到还没答复的审批请求。
   SDK 注释明确说：**同一个 request_id 可能既出现在这里、又作为实时帧到达，
   接收方必须容忍重复、只渲染一次。** 不做去重就会弹两个框。
2. **有取消机制**。对方可能撤回一个还在飞的 control_request
   （比如轮次被中断了，那个 `can_use_tool` 就不需要答复了）。
   收到取消要停止等待，并忽略之后可能仍然到达的 control_response。

这两条不看类型定义根本不会想到，但不做就会出诡异 bug。

## 4. 用量与订阅额度 ✅（类型）

**走 `get_usage` 控制请求，不要碰 `/api/oauth/usage`。**

响应 `SDKControlGetUsageResponse`：

```ts
{
  session: {
    total_cost_usd: number
    total_api_duration_ms: number
    total_duration_ms: number
    total_lines_added: number
    total_lines_removed: number
    model_usage: Record<string, ModelUsage>   // 按模型分
  }
  subscription_type: string | null      // 'pro' | 'max' | 'team' | 'enterprise'
                                        // API key / 三方供应商时为 null
  rate_limits_available: boolean        // false → rate_limits 是 null
  rate_limits: {
    five_hour?:        { utilization: number | null, resets_at: string | null } | null
    seven_day?:        { ... } | null
    seven_day_opus?:   { ... } | null
    seven_day_sonnet?: { ... } | null
    seven_day_oauth_apps?: { ... } | null
  } | null
}
```

`utilization` 是 0-100 的百分比，`resets_at` 是 ISO 8601。

**还有推送**：`SDKRateLimitEvent`（`type: 'rate_limit_event'`）会主动出现在
消息流里，带 `SDKRateLimitInfo`：`status`（`allowed` / `allowed_warning` /
`rejected`）、`rateLimitType`、`utilization`、`resetsAt`、以及一整套
overage（超额）字段。

**所以用量面板可以是推送驱动的，不用轮询。**

### 仍然要可降级的两个理由

1. SDK 里那个方法名叫
   `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`。
   官方自己标了会变。
2. `rate_limits_available: false` 是**正常情况**——API key 用户、
   Bedrock、Vertex 都没有订阅额度。这不是错误，UI 要能优雅地不显示。

## 5. Hooks ✅

```
SessionStart  SessionEnd  UserPromptSubmit  PreToolUse  PostToolUse
Stop  SubagentStop  Notification  PreCompact
```

M10 的交接用 `SessionEnd`。

## 6. 已作废的方案 ❌

以下是我最初的设计，发现 `get_usage` 之后**不要再做**：

- ~~直接请求 `/api/oauth/usage`~~ —— 内部端点，`get_usage` 已覆盖且是声明过的接口
- ~~statusline 脚本落盘侧路~~ —— 绕一大圈拿到的数据 `get_usage` 直接给

留在这里是为了防止将来有人（包括你自己）重新想到这两条路又走一遍。

---

## 升级 CC 之后的检查单

```sh
pnpm up @anthropic-ai/claude-agent-sdk   # 类型跟着二进制走
pnpm typecheck                            # 类型变了这里先红
pnpm test:contract                        # 重跑 probe
git diff test/fixtures/recorded/          # 运行时形状变了没
```

**`pnpm typecheck` 会先红**——这是免费的早期预警，比 probe 还早。
