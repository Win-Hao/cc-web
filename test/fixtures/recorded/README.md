# 录制的真实帧

这里的文件由 `pnpm test:contract` 用**我们自己的 Engine**（src/engine）驱动
真实 `claude` 录出来，**要提交进 git**。`*.meta.json` 里的 `sent` 就是
Engine 实际发出的帧（request_id 是 probe 注入的固定序号 `probe-N`），
`args` 是能力探测之后实际的 spawn 参数。

单元测试回放这些帧，所以它们是「上游协议长什么样」的唯一事实来源。
CC 升级之后重跑 probe，`git diff` 这个目录就能看到协议变了没。

现有 fixture（claude 2.1.243 录制，版本见各 `.meta.json`）：

- `simple-turn.ndjson` —— 一轮最简对话：system init / stream_event / user 回显 / assistant / result
- `tool-turn.ndjson` —— 带工具调用的一轮：content_block_start(tool_use) →
  input_json_delta 分片 → assistant(tool_use) → user(tool_result) → 收尾文本 → result
- `*.events.json` —— **黄金文件**（D7）：上面两份帧喂给服务器的 normalizer 之后
  发给浏览器的事件序列。由 `test/server/message/live.spec.ts` 生成 / 比对；
  升级 CC 重录帧后，diff 它能看到协议变化有没有穿透到浏览器
- `control.ndjson` —— 控制协议：initialize（响应带 commands 等）、
  list_models（models 数组：value / resolvedModel / displayName …）、
  set_model（success 无 payload）
- `*.meta.json` —— 录制时的 claude 版本 + spawn 参数 + Engine 发出的 stdin 帧
- `.sample-turn.ndjson` —— 手写的最小样本，给 M0 基础设施自测用（非录制）
