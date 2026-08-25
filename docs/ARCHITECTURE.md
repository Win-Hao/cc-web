# 架构

## 分层

```
浏览器 (src/web)          ← 薄客户端，无逻辑，无测试
   │  HTTP + WebSocket
   ▼
服务器 (src/server)       ← 路由、鉴权、WS 广播
   │
   ├── src/auth      token 生成/校验
   ├── src/sessions  读 ~/.claude/projects/**/*.jsonl
   ├── src/usage     用量聚合（会话级 + 订阅级）
   │
   └── src/engine    ← 唯一跟 CC 打交道的地方
          │ spawn + stdin/stdout NDJSON
          ▼
      claude -p --verbose --input-format stream-json
             --output-format stream-json --include-partial-messages
             --resume <id>
```

**只有 `src/engine` 知道 CC 的存在。** 上游改协议时，改动面被关在一个目录里。

## 数据有两条来源，别混

| 数据 | 来源 | 什么时候用 |
| --- | --- | --- |
| 历史消息 | `~/.claude/projects/<slug>/<uuid>.jsonl` | 打开页面时回填 |
| 实时事件 | 引擎进程的 stdout | 会话进行中 |

两者格式**不完全一样**（jsonl 是落盘记录，stream-json 是实时帧），
所以 `src/sessions` 和 `src/engine` 各自解析，在 server 层归一化成
一套给前端的事件类型。这层归一化是纯函数，好测。

---

## 七条决策

### D1：引擎用 headless CLI，不用 SDK 运行时

装 `@anthropic-ai/claude-agent-sdk` **只为拿 TypeScript 类型**，
运行时还是自己 spawn `claude`。

**为什么**：引擎是用户日常用的那个 CC 本体，行为不会漂移——插件、hooks、
CLAUDE.md、MCP 全都照常生效。用 SDK 运行时则要自己复现这些加载逻辑。

**代价**：进程管理要自己做（见 D3）。

### D2：UI 是薄客户端，且**不写测试**

所有逻辑在 server。`src/web` 只做三件事：发 HTTP、收 WS、渲染。

**为什么**：这是「以后换 UI 组件成本为零」的唯一保证。
不是靠自觉——靠规则：**`src/web` 下不允许出现测试文件**。
写着写着想给 UI 加测试了，说明有逻辑漏到 UI 里了，把它推回 server。

### D3：一个会话一个引擎进程

`--resume <id>` 把进程绑定到具体会话，所以是进程池，键是 session id。

- 空闲 N 分钟回收（默认 15），**只回收 idle 状态的进程**——
  running / waiting-approval 的不许动，否则回收器本身就是 R2 的另一种死法
- **子进程必须跟服务器同生共死**：退出路径全挂清理（SIGINT/SIGTERM/
  `beforeExit`），清理时按**进程组**杀。要杀进程组需要
  `detached: true`（子进程成为 group leader）+ `process.kill(-pid)`——
  「不 detach」反而是反模式，详见 RISKS R1
- spawn 的 `cwd` 必须设为会话原 cwd（resume 时从 jsonl 行的 `cwd` 字段读，
  见 PROTOCOL §2），否则 CLAUDE.md 和相对路径全错
- 同一 session 的第二次请求复用同一个进程，不重复 spawn

有同类项目早期版本带后台 daemon，后来专门写了清理脚本
去清理漏下的守护进程。**别重蹈覆辙**，从第一天就前台化。

### D4：契约测试隔离上游变化

这是「后续更新方便」的核心机制，也是整个方案里最值钱的一条。

```
test/contract/*.probe.ts   跑真实 claude，录制真实帧 → test/fixtures/recorded/
test/**/*.spec.ts          只跑假二进制，读 recorded fixture，秒级
```

CC 升级之后：重跑 probe → `git diff` fixture → **一眼看到协议哪里变了**，
而不是等某个功能在生产里静默坏掉。

单元测试永远不碰真实二进制，所以 `pnpm test` 快、离线、无需登录态。

### D5：用量走 `get_usage`，但仍要可降级

用量有官方通道：`get_usage` 控制请求，一次拿到会话成本
（`total_cost_usd`、按模型分的 `model_usage`、增删行数）
**和**订阅额度（`five_hour` / `seven_day` / `seven_day_opus` …，
每个带 `utilization` 0-100 和 `resets_at`）。
另有 `rate_limit_event` 推送，所以面板可以是推送驱动的，不用轮询。

**不要碰 `/api/oauth/usage`，也不要做 statusline 侧路**——
这两条是我最初的设计，`get_usage` 出来之后都是绕远路。见 PROTOCOL §6。

但**可降级还是要做**，两个理由：

1. SDK 那个方法名字就叫 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`，
   官方自己标了会变。
2. `rate_limits_available: false` 是**正常情况**——API key 用户、Bedrock、
   Vertex 都没有订阅额度。UI 要能优雅地不显示，而不是报错。

**拿不到就不显示，绝不让用量面板挂掉影响聊天。**

会话级用量有两个来源，优先级钉死：**引擎活着走 `get_usage`**（含官方
成本），引擎已被回收则降级到 `src/usage` 的 jsonl 聚合（只有 token 量）。
对前端暴露同一接口形状，来源差异不外泄。

### D6：鉴权，包括那个时序坑

- token 存 `~/.cc-web/server.token`，权限 `0600`
- URL 用 `#token=` **fragment**，不是 query——fragment 浏览器不发给服务端，
  不会进 access log
- **token 必须在服务器 listening 之后才读**。有同类项目源码里专门写了注释：
  全新服务器是首次启动时才写 token 文件，提前读会读到空，
  浏览器直接撞鉴权门。这个坑只有首次安装的人会遇到，本机开发永远复现不了
- 默认绑 `127.0.0.1`。这个服务器能读写文件、跑 shell，绑 `0.0.0.0` 等于
  把机器交出去

### D7：归一化只在服务器做一次，浏览器只有两个原语

历史（jsonl 行）和实时（引擎 stdout 帧）在 `src/server/message` 里归一化成
**同一个 Message 形状**再出门；浏览器对消息只做两件事：
`upsert(message)`（按 key 追加或替换）和 `append_delta(key, kind, chunk)`。
原帧不再经 WS 透传。

服务器为**正在进行的回合**持有一份有界状态（正在流的消息、还没有结果的
tool_use），用来：块开始时发 placeholder、tool_result 到了配对回 tool_use 块、
回合结束 / 中断 / 引擎退出时把剩余的判成 canceled、新标签页订阅时给一份
进行中消息的快照。回合一结束状态即清空，历史仍从 jsonl 出。

**为什么**：D2 说逻辑在 server，但归一化只做了历史那一半，实时帧原样透传，
浏览器长出了 500 多行不许测的第二个 normalizer（tool 配对 3 处、canceled 2 处、
三段逐行抄自服务器的代码）。归一化收回来，D2 才是真的。

**为什么不把整个会话放内存**：R9 的几十 MB 会话再复制一份不值；
回合级状态已经够用，且天然有界。

**代价**：
- 服务器多一份回合级状态，引擎退出必须清干净；
- 事实来源仍是录制帧（D4），normalizer 的输出另配黄金文件
  `test/fixtures/recorded/*.events.json`——升级 CC 后 diff 它，
  能看到协议变化有没有穿透到浏览器。

---

## 交接怎么做（M10）

CC 没有「TUI 退出后把进程让给服务器」的原生接管点——
`run-shell.ts:250` 那个岔路口在 CC 里不存在，而且二进制改不了。

能做到的最近似：`SessionEnd` hook。

```
/cc-web (skill)  → 拿到 session id，写标记文件，提示用户退出
     ↓
SessionEnd hook  → 读标记，启动服务器，带上 session id
```

**这条链路的限制要认**：hook 是 CC spawn 的子进程，CC 主进程该退还是退，
拿不到「同一个 PID 从 TUI 变服务器」的效果。所以孤儿进程风险回来了，
D3 那套进程管理必须做扎实。

另一条更简单的路：**不做交接**，服务器是独立 CLI（`cc-web --resume <id>`），
用户自己开一个终端跑。丑一点，但没有 hook 的时序问题。
建议 M10 先做这个，交接当增强。

hook 要写进用户的 `~/.claude/settings.json`：安装时**合并而不是覆盖**
用户已有的 hooks，卸载时只删自己那条。这个文件是用户的，弄坏了影响的是
日常 TUI。
