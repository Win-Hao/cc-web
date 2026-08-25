# 给 agent 写文档的规矩（附调研依据）

调研日期 2026-08-25。扒了四个主流 agent 项目的实际做法，对照了实证研究。
**研究结论和大厂做法是打架的**，这里记下来免得以后重新踩。

## 一句话结论

**常驻上下文越小越好，规则越少越好，但每条留下的规则都必须有机器执行者。**

---

## 研究说了什么

Gloaguen 等人 2026-02 的论文
[*Evaluating AGENTS.md*](https://arxiv.org/abs/2602.11988)：

| 发现 | 数字 |
| --- | --- |
| AI 生成的 context 文件 | 成功率 **-3%**，推理成本 **+20%** |
| 人写的 context 文件 | 成功率 **+4%**，成本 **+19%** |
| 有 context 文件时的推理 token | GPT-5.2 **+22%**，GPT-5.1 Mini **+14%** |
| 把冗余文档删掉之后 | context 文件才开始有用，**+2.7%** |

论文的解释：

> 不必要的要求损害 agent 表现，**不是因为 agent 忽略它们，而是因为 agent
> 太老实地遵守了**——探索面被撑大，推理成本上升，结果没变好。

另一项（Distyl AI）：20 个前沿模型，最多 500 条同时生效的指令，
**最好的只做到 68%**——三条里漏一条。且都有 primacy bias，
**靠前的指令执行得更可靠**。

**所以人写的净收益是 +4% 成功率 / +19% 成本。** 划不划算要自己判断，
但至少说明「多写文档 = 更好」是错的。

---

## 四个真实项目怎么做

| 项目 | 体量 | 强制手段 |
| --- | --- | --- |
| openai/codex | ~2800 词 / 13 节 | `just fmt`、`just fix`、**`just argument-comment-lint`** |
| block/goose | ~1350 词 / 11 节 | `cargo clippy -- -D warnings`、**`goose run --recipe goose-self-test.yaml`** |
| sst/opencode | ~1800 词 / 5 节 | `bun typecheck`、守卫 `do-not-run-tests-from-root` |
| All-Hands-AI/OpenHands | 很长 | **`no-direct-agent-server-calls.test.ts`**（架构约束写成测试） |

**共同点只有一个：每条真正在乎的规则背后都有一个命令。**
风格偏好写成散文，硬约束写成检查器。

三个值得偷的：

- **codex** 为一条注释约定专门写了 lint（`argument-comment-lint`）
- **OpenHands** 把「前端不许直连后端」写成一个测试文件
- **OpenHands** 在 PR 描述里留 `HUMAN:` 段，**明令 AI 不许碰**

## kimi-code 的做法（本项目的参照）

```
根 AGENTS.md            92 行    ← 常驻上下文
各包 AGENTS.md       12-96 行    ← 就近命中
.agents/skills/*     4530 行    ← 按需加载
```

常驻只有 92 行，4530 行按 **Orient → Design → Implement → Test → Verify**
分成 19 个 stage 文件，agent 进到那个包干活时才读**一个**。

**这正是研究结论的解药**：被批的是「一大坨全塞进上下文」，不是「文档多」。
扒的四个项目里没有一个做到这个粒度。

它还有个反面教训：那 4530 行 skill 和 `docs/` 里的内容会漂移，
**而没有检查器守着**——按它自己「每条规则要有执行者」的原则，这是个漏洞。

---

## 本项目的规矩

1. **根 `AGENTS.md` 不超过 40 行。** 由 `scripts/check-conventions.mjs` 强制。
   超了就拆到 `docs/` 里按需读，不要往上堆。
2. **重要的放前面。** primacy bias 是实测的。
3. **一次加一条规则，且只在观察到重复错误之后加。**
   论文建议从空文件起步——每条规则都在花成本。
4. **写「不要 X」时必须给替代路径。** 只写禁止，agent 会自己发明更糟的绕法。
5. **`docs/` 是按需读的，不进 AGENTS.md。** 那六份文档给人和 agent 深读，
   不是常驻上下文。

## 来源

- [Evaluating AGENTS.md (arXiv 2602.11988)](https://arxiv.org/abs/2602.11988)
- [The research is in: your AGENTS.md is probably too long — Upsun](https://developer.upsun.com/posts/ai/agents-md-less-is-more)
- [AGENTS.md 规范](https://agents.md/) —— 2025-08 由 OpenAI 牵头定标，
  2025-12 捐给 Linux 基金会 Agentic AI Foundation
- [openai/codex](https://github.com/openai/codex/blob/main/AGENTS.md) ·
  [block/goose](https://github.com/block/goose/blob/main/AGENTS.md) ·
  [sst/opencode](https://github.com/sst/opencode/blob/dev/AGENTS.md) ·
  [OpenHands](https://github.com/All-Hands-AI/OpenHands/blob/main/AGENTS.md)
