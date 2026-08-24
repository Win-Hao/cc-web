/**
 * cwd ↔ ~/.claude/projects/<slug> 的映射。
 *
 * 算法按本机真实数据验证（见 test/sessions/slug.spec.ts 的中文用例）：
 * 所有非 [a-zA-Z0-9] 的字符**逐个**替换成 '-'，不折叠。
 *
 * 注意 slug → cwd 不可逆（'-' 既可能来自 '/'，也可能来自名字里原有的
 * '-'、'.'、中文……），所以反查不在这里做：会话的 cwd 从 jsonl 行的
 * `cwd` 字段读（PROTOCOL §2 说每行都带），见 list.ts / parse.ts。
 */
import { homedir } from 'node:os'

/** 展开开头的 `~` / `~/...`；其它形式原样返回。 */
export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return homedir() + p.slice(1)
  return p
}

/** 工作目录路径 → ~/.claude/projects 下的目录名。 */
export function cwdToSlug(cwd: string): string {
  let p = expandHome(cwd)
  // 末尾斜杠归一（根目录 "/" 除外——虽然没人拿根目录当项目目录）
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  return p.replace(/[^a-zA-Z0-9]/g, '-')
}
