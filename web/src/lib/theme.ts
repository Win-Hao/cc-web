/**
 * 外观（M32）：system / light / dark，localStorage 持久化，
 * html[data-theme] 驱动 globals.css 的变量覆盖块。
 */
export type Theme = 'system' | 'light' | 'dark'

const KEY = 'cc-web.theme'

export function getTheme(): Theme {
  const v = localStorage.getItem(KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

export function applyTheme(theme: Theme): void {
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
}

export function setTheme(theme: Theme): void {
  if (theme === 'system') localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, theme)
  applyTheme(theme)
}

export function initTheme(): void {
  applyTheme(getTheme())
}
