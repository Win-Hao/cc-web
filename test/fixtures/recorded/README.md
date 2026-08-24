# 录制的真实帧

这里的文件由 `pnpm test:contract` 跑真实 `claude` 录出来，**要提交进 git**。

单元测试回放这些帧，所以它们是「上游协议长什么样」的唯一事实来源。
CC 升级之后重跑 probe，`git diff` 这个目录就能看到协议变了没。

现有 fixture（claude 2.1.241 录制，版本见各 `.meta.json`）：

- `simple-turn.ndjson` —— 一轮最简对话：system init / stream_event / assistant / result
- `control.ndjson` —— 控制协议：initialize（响应带 commands 等）、
  list_models（models 数组：value / resolvedModel / displayName …）、
  set_model（success 无 payload）
- `*.meta.json` —— 录制时的 claude 版本 + 我们发出的 stdin 帧
- `.sample-turn.ndjson` —— 手写的最小样本，给 M0 基础设施自测用（非录制）
