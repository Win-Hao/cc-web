# 已知的坑

## R1 孤儿进程 —— 最可能翻车的地方

引擎是子进程。服务器被 `kill -9`、崩溃、或者忘了挂信号处理，
子进程就活下来了，占着 session、占着额度。

**对策**：退出路径全挂（SIGINT / SIGTERM / `beforeExit` /
`uncaughtException`）；按**进程组**杀，不是只杀直接子进程
（CC 自己也会 spawn 东西）。

注意一个反直觉的点：要杀进程组，子进程得是 group leader，这恰恰需要
`detached: true`（setsid），然后 `process.kill(-pid)`。
「不 detach」在这里是**反模式**——不 detach 子进程跟服务器同组，
`kill(-pid)` 直接失败，孙进程就漏了。真正要守的不是字面上的不 detach，
而是「退出路径全挂清理，绝不 spawn 完就放手」。

**前车之鉴**：有同类项目早期版本带后台 daemon，后来为了收拾漏下的守护进程，
专门写了 `legacy-kill.ts`——9KB，一整个文件，只为擦一个已经删掉的设计的屁股。

## R2 工具审批卡死 —— 最容易做错的地方

`can_use_tool` 是 CC **反向问我们**。不回，它就一直等。

用户关掉浏览器标签页 → 没人回 → 引擎永久挂起 → 占着进程和 session。

**对策**：审批必须有超时（默认 5 分钟），到点自动 deny。
超时之后用户才点，要返回「已过期」而不是崩。
审批的任何终态（allow / deny / 超时 / 被取消）都广播
`approval_resolved` 事件，让所有标签页同步关弹框。
`docs/TDD.md` M7 里有对应测试。

## R3 上游协议变化

CC 是二进制，版本一升协议可能就变了，而且**不会有 changelog 告诉你**。

**对策**：D4 的契约测试。升级后重跑 probe、diff fixture。
这是唯一能在「静默损坏」之前发现变化的手段。

## R4 用量接口标了 EXPERIMENTAL

`get_usage` 是声明过的控制请求（比内部 HTTP 端点好得多），但 SDK 里
那个方法名直接叫 `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`。

而且 `rate_limits_available: false` 是**正常情况**，不是故障——
API key 用户、Bedrock、Vertex 都没有订阅额度。

**对策**：D5，可降级。拿不到 → 不显示，`code` 仍返回 0。
**绝不能让用量面板挂掉影响聊天。**

## R5 审批请求会重复到达

SDK 注释明确写了：`initialize` 的响应里带 `pending_permission_requests`，
**同一个 request_id 可能既在这里、又作为实时帧到达**，接收方必须去重。

不做去重 → 浏览器弹两个一模一样的审批框，用户点了一个另一个还在。

**对策**：按 request_id 去重（引擎层，`test/engine/protocol.spec.ts`）。同时要处理**取消**——
对方可能撤回还在飞的请求（轮次被中断时那个 `can_use_tool` 就不需要答了），
收到取消要停止等待并忽略后到的 response。

## R6 这个服务器权限极大

它能读写文件、跑 shell 命令——就是 CC 的全部能力。
谁能连上这个端口，谁就控制了这台机器。

**对策**：默认 `127.0.0.1`；bearer token 必须做（M8）；
token 走 fragment 不进日志；**不提供 bypass-auth 开关**
（有同类项目提供了，但那是给有反向代理的场景用的，我们不需要，
少一个能把自己打死的按钮）。

## R7 多标签页 / 并发

两个标签页开同一个 session，同时发提示词会怎样？

**对策**：M4/M5 要有并发测试。最简单的策略是**串行化**：
session 级别的队列，一次只处理一个 prompt，第二个排队或直接拒绝。
先做拒绝（简单、行为明确），有需求再做队列。

另一个并发边角：**waiting-approval 状态下收到新 prompt，直接拒绝**并提示
先处理审批。审批挂起时注入新轮次行为未定义，别试。

## R8 subagent 输出混进主线

jsonl 里 `isSidechain: true` 是 subagent 的消息。
不处理的话，Task 工具跑起来时浏览器里会突然冒出一大堆看不懂的对话。

**对策**：M2 就把它分开，别等 UI 阶段才发现。

## R9 会话历史可能很大

长会话的 jsonl 能到几十 MB。一次全读进内存再 JSON 序列化给前端，
浏览器会卡死。

**对策**：`/history` 从一开始就分页（cursor 式，见 API.md）。
M3 的接口设计里就带上，不要「先做简单版以后再说」——以后改要动前端。
