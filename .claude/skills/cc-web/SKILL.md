---
name: cc-web
description: 交接当前 Claude Code 会话到 cc-web 本地 Web UI。用户说「/cc-web」「交接到网页/浏览器」「继续在浏览器里聊」时使用。
---

# 交接到 cc-web

把当前 TUI 会话交给 cc-web 的浏览器界面继续。流程（docs/ARCHITECTURE.md「交接怎么做」）：

1. 写意图标记（内容就是 `{}`——会话 id 由 SessionEnd hook 从 stdin 的
   hook 输入里拿，这里不用也不该写）：

   ```sh
   mkdir -p ~/.cc-web && printf '{}' > ~/.cc-web/handoff.json
   ```

2. 告诉用户：标记已写好，现在退出 Claude Code（`/exit` 或连按 Ctrl+C）。
   退出瞬间 SessionEnd hook 会启动 cc-web 服务器（`--resume` 本会话）并
   打开浏览器，网页端接着聊。

**不要**自己启动服务器：会话仍被当前 CC 进程占用，必须等退出后由 hook 拉起。
前置条件（没装的话提醒用户看 README「交接」一节）：SessionEnd hook 已
指向本仓库的 `scripts/session-end-hook.mjs`。
