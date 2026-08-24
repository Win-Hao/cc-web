/**
 * M2：cwd 路径 → slug。
 *
 * slug 算法的 ground truth 来自本机真实数据（~/.claude/projects）：
 *   /Users/x/Documents/内容创作/小云雀+seedance2.5/今日题材
 *   → -Users-x-Documents----------seedance2-5-----
 * 即：所有非 [a-zA-Z0-9] 字符**逐个**替换为 '-'，不折叠连续 '-'。
 */
import { describe, it, expect } from 'vitest'
import { cwdToSlug } from '#/sessions/slug.js'

describe('cwdToSlug', () => {
  it('普通 posix 路径：斜杠变短横', () => {
    expect(cwdToSlug('/Users/x/proj')).toBe('-Users-x-proj')
  })

  it('末尾斜杠不影响结果', () => {
    expect(cwdToSlug('/Users/x/proj/')).toBe('-Users-x-proj')
  })

  it('中文路径：每个非 ASCII 字符各变成一个短横（与真实 CC 行为一致）', () => {
    // 真实样本：~/Documents/内容创作/小云雀+seedance2.5/今日题材
    expect(cwdToSlug('/Users/x/Documents/内容创作/小云雀+seedance2.5/今日题材')).toBe(
      '-Users-x-Documents----------seedance2-5-----',
    )
  })

  it('~ 展开为 home 目录后再转 slug', () => {
    expect(cwdToSlug('~/proj')).toBe(cwdToSlug(`${process.env.HOME}/proj`))
  })

  it('路径里已有的短横、点号：短横保留、点号变短横', () => {
    expect(cwdToSlug('/Users/x/vibe-coding/my-app')).toBe(
      '-Users-x-vibe-coding-my-app',
    )
    expect(cwdToSlug('/tmp/tmp.abc/sub')).toBe('-tmp-tmp-abc-sub')
  })
})
