/** 内联 stroke 图标（按通用做法 用 Remix/Tabler 的观感，currentColor 跟随文字色） */
interface IconProps {
  size?: number
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
})

export const FolderIcon = ({ size = 15 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M3 19V5.5A1.5 1.5 0 0 1 4.5 4h4.1a1.5 1.5 0 0 1 1.2.6L11.3 6h8.2A1.5 1.5 0 0 1 21 7.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19Z" />
  </svg>
)

export const SearchIcon = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
)

export const ChevronDownIcon = ({ size = 13 }: IconProps) => (
  <svg {...base(size)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
)

export const ChevronUpIcon = ({ size = 13 }: IconProps) => (
  <svg {...base(size)}>
    <path d="m6 15 6-6 6 6" />
  </svg>
)

export const SendIcon = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} strokeWidth={2.2}>
    <path d="M12 19V5" />
    <path d="m5 12 7-7 7 7" />
  </svg>
)

export const StopIcon = ({ size = 12 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <rect x="5" y="5" width="14" height="14" rx="2.5" />
  </svg>
)

export const PlusIcon = ({ size = 15 }: IconProps) => (
  <svg {...base(size)} strokeWidth={2}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)
