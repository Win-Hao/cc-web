# TDD 工作流

## 两类测试，界限要清楚

| | 单元测试 | 契约测试 |
| --- | --- | --- |
| 命令 | `pnpm test` | `pnpm test:contract` |
| 文件 | `test/**/*.spec.ts` | `test/contract/*.probe.ts` |
| 跑什么 | **假 `claude`** | **真 `claude`** |
| 速度 | 秒级 | 慢，要登录态 |
| 何时跑 | 每次改代码 | CC 升级后、M1 之后一次 |
| 能进 CI 吗 | 能 | 不能（需要凭证） |

**单元测试永远不碰真实二进制。** 这条不能破——破了之后测试会变慢、
会依赖网络、会因为额度用完而红，然后你就不跑测试了。

## 为什么这么分

CC 是分发的二进制，协议随版本变。契约测试**录制**真实帧，
单元测试**回放**录到的帧：

```
probe（手动跑） → test/fixtures/recorded/*.ndjson  → git 提交
                                  ↓
                    spec（每次跑）读 fixture 回放
```

CC 升级之后：

```sh
pnpm test:contract
git diff test/fixtures/recorded/
```

diff 为空 → 上游没动协议。有 diff → **你在一分钟内就知道变了什么**，
而不是等某个功能在生产里静默坏掉。

这就是「后续更新方便」的全部机密。

## 假二进制

`test/fixtures/fake-claude.mjs` 已经写好了（这是测试基础设施，不是实现）。
它读一个 fixture 文件，按行吐 NDJSON 到 stdout，同时把收到的 stdin
落盘供断言。用法：

```ts
const engine = new Engine({
  bin: process.execPath,
  args: [FAKE_CLAUDE, '--script', 'fixtures/recorded/simple-turn.ndjson'],
})
```

引擎构造函数**必须允许注入 bin 和 args**——这是可测性的前提，
第一行实现代码就要考虑。

## 红-绿-重构的节奏

1. 从下面的清单里挑**一条**测试，写出来，**跑，看它红**
2. 写最少的代码让它绿
3. 重构，保持绿
4. 提交

「跑，看它红」不能跳。没见过红的测试，你不知道它是真的在测东西，
还是写错了断言永远绿。

---

# 测试清单

每条都是一个 `it(...)`。按顺序做。

## M0 测试基础设施

- [x] 假二进制能被 spawn，吐出 fixture 里的行
- [x] 假二进制把收到的 stdin 写进了落盘文件
- [x] vitest 能跑，覆盖率报告能出

**M0 的产出是「测试跑得起来」，没有业务代码。** 别跳过。

## M1 引擎层

**构造与生命周期**
- [x] 用注入的 bin/args 构造，不去找真实 `claude`
- [x] `start()` 之后进程在跑
- [x] `stop()` 之后进程没了
- [x] 进程自己崩了会 emit `error`，不会静默
- [x] **服务器进程退出时子进程一起死**（SIGINT / SIGTERM / 正常退出各一条）
- [x] **按进程组杀，孙进程也死**（子进程里再 spawn 一个 sleeper，断言它没了）
- [x] **空闲回收只动 idle 进程**——running / waiting-approval 的到点不被回收

**NDJSON 解析**
- [x] 完整的一行 → 一个事件
- [x] **一行被拆成两个 chunk → 仍然只出一个事件**（粘包，必测）
- [x] 一个 chunk 里有多行 → 出多个事件
- [x] 空行跳过
- [x] **坏 JSON 不炸进程**，emit `error` 后继续读下一行

粘包和坏 JSON 这两条是 NDJSON 解析器 100% 会遇到的，
不测就等着在生产里遇到。

## M2 会话读取

- [x] cwd 路径 → slug（含末尾斜杠、中文路径、`~` 展开）
- [x] 列出某目录下的所有会话，按 mtime 倒序
- [x] 解析 jsonl，跳过坏行
- [x] **空文件返回空数组，不抛**
- [x] 从 `message.usage` 聚合本会话总量
- [x] 聚合区分 input / output / cache_read / cache_creation / thinking
- [x] `isSidechain: true` 的消息**不计入主线**（或单独计，二选一，但要有测试）
- [x] `parentUuid` 能还原消息顺序

## M3 HTTP 只读

- [x] `GET /api/v1/meta` 返回信封，`code === 0`
- [x] `GET /api/v1/sessions` 返回列表
- [x] `GET /api/v1/sessions/:id/history` 返回消息
- [x] 不存在的 id → **信封里 `code !== 0`，HTTP 仍是 200**
- [x] 未知路径 → 404
- [x] 端口被占用时自动 +1

## M4 WebSocket

- [x] 连上之后能收到 `state` 事件
- [x] 引擎 emit 的事件被推给客户端
- [x] **两个客户端连同一 session，都收到**（多标签页）
- [x] 客户端断开，服务器不崩
- [x] 客户端断开后引擎**不**被回收（用户可能只是刷新页面）
- [x] **断线重连带 `?since=<seq>` 补发缺失事件**——事件带 session 级
      单调递增 seq，服务器留滚动 buffer。刷新页面不该丢正在流的输出
      （`/history` 补不上这段：jsonl 落盘有延迟）

## M5 提示词 + 中断

- [x] `POST /prompt` 把内容写进了引擎 stdin（断言落盘文件）
- [x] 引擎输出的 delta 通过 WS 到达客户端
- [x] `POST /interrupt` 发出了 `interrupt` 控制帧
- [x] 会话不在跑的时候 interrupt 不报错

## M6 控制协议 ⚠️ 先跑 probe

**做这个之前先 `pnpm test:contract` 录一遍真实帧。**

- [x] `POST /model` 发出的帧**跟录到的真实帧结构一致**
- [x] 收到 `control_response` 后 resolve
- [x] 控制请求超时会 reject，不会永久挂起
- [x] `set_permission_mode` 同上
- [x] **切模型之后会话没断**（下一轮还在同一 session）
- [x] `list_models` 返回可用模型列表（下拉框从 CC 拿，不硬编码）
- [x] `list_models` 失败时前端有兜底，不至于下拉框空白
- [x] **对 idle 会话发控制请求：先按需拉起引擎，initialize 完成之后帧才发出**

最后三条里第一条是这个功能的意义所在，必须有。

## M7 工具审批 ⚠️ 最容易做错

- [x] 收到 `can_use_tool` → emit `approval` 事件，带 requestId
- [x] `POST /approvals/:requestId` allow → 发出 allow 的 control_response
- [x] deny 同上，且 deny 理由带回去了
- [x] **超时未响应 → 自动 deny**（默认 5 分钟）
- [x] **超时之后用户才点 → 不崩，返回「已过期」**
- [x] 未知 requestId → 报错不崩
- [x] **同时来两个审批请求，各自独立**（并发，必测）
- [x] 浏览器全断开时仍然会走超时逻辑
- [x] **同一 requestId 从 `pending_permission_requests` 和实时帧各来一次
      → 只 emit 一个 approval 事件**（SDK 注释明说会发生，见 RISKS R5）
- [x] 收到取消 → 停止等待，之后到达的 control_response 被忽略
- [x] **同一 requestId 被另一个客户端答复后再 POST → 返回「已过期」，
      不报错不崩**（多标签页场景，两个框都被点了）
- [x] 审批终态（allow / deny / 超时 / 取消）广播 `approval_resolved`，
      带 requestId——所有标签页同步关弹框

超时那几条是核心：不做超时，用户关掉浏览器就把引擎永久卡死了。
去重那条不看 SDK 类型注释根本想不到，但不做就会弹两个框。

## M8 鉴权

- [x] 首次启动生成 token，文件权限 `0600`
- [x] 重启复用同一 token
- [x] **token 在 listening 之后才读**（构造一个「文件启动时不存在」的用例）
- [x] 无 token 的请求 → 401
- [x] 错 token → 401
- [x] WS 子协议 `cc-web.bearer.<token>` 能通过
- [x] URL 生成用 `#token=`，**不是 `?token=`**
- [x] 默认 host 是 `127.0.0.1`

倒数第二条写个断言看着像多余，但正是这种「写反了也能跑」的地方
最需要测试钉住。

## M9 用量

走 `get_usage` 控制请求，**不是** HTTP 端点、**不是** statusline
（那两条是作废方案，见 PROTOCOL §6）。

- [x] `GET /sessions/:id/usage` 从 `get_usage` 拿到 session 段
- [x] 返回里包含 `total_cost_usd` 和按模型分的 `model_usage`
- [x] `GET /usage` 返回 `rate_limits`，`utilization` 是 0-100
- [x] **`rate_limits_available: false` → 返回 null，`code` 仍是 0**
      （API key / Bedrock / Vertex 用户，正常情况不是错误）
- [x] `get_usage` 超时 → 返回 null，不抛
- [x] `get_usage` 返回了没见过的字段 → 不崩（上游会加字段）
- [x] `rate_limit_event` 推送 → 通过 WS 转给前端
- [x] `status: 'rejected'` 的额度事件在 UI 上要能区分出来
- [x] **用量拿不到时，`/sessions/:id/history` 等接口不受影响**
- [x] **引擎已回收的会话：`/sessions/:id/usage` 降级到 jsonl 聚合，
      接口形状不变**（token 量有，官方成本没有）

最后一条是 D5 的本体：用量挂了不能带着聊天一起挂。
倒数第四条（未知字段）值得单独写：上游加字段是常态，
用严格 schema 校验会把自己搞死。

## M10 交接

- [x] `cc-web --resume <id>` 起服务器并打开对的 URL
- [x] URL 里有 session id 和 `#token=`
- [x] `--no-open` 不开浏览器
- [x] SessionEnd hook 脚本：有标记文件才启动
- [x] hook 脚本：读完标记就删，不会下次误触发

## M11 占位 UI

**不写测试**（见 ARCHITECTURE D2）。
手工验一遍：能看历史、能发消息、能看到流式输出、能弹审批、能切模型。

---

## 覆盖率

不设百分比门槛——`src/web` 本来就不测，全局数字没意义。
真正要守的是：**`src/engine` 和 `src/sessions` 的每个分支都有测试。**
这两个目录是所有 bug 的来源，其它都是管道。
