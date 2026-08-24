/**
 * 新建会话：选一个已知项目目录，或手输路径。
 * 项目列表来自现有会话的 cwd（按最近活跃排序），默认选中当前会话所在项目。
 */
import { useState } from 'react'
import { FolderIcon } from './icons'

export interface ProjectChoice {
  cwd: string
  name: string
}

interface Props {
  projects: ProjectChoice[]
  defaultCwd: string | null
  onCancel: () => void
  onCreate: (cwd: string) => void
}

export function NewSessionDialog({ projects, defaultCwd, onCancel, onCreate }: Props) {
  const [picked, setPicked] = useState<string | null>(defaultCwd ?? projects[0]?.cwd ?? null)
  const [custom, setCustom] = useState('')

  const cwd = custom.trim() !== '' ? custom.trim() : picked
  const submit = () => {
    if (cwd !== null && cwd !== '') onCreate(cwd)
  }

  return (
    <div className="backdrop" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>新建会话</h3>
        {projects.length > 0 && (
          <div className="proj-list">
            {projects.map((p) => (
              <div
                key={p.cwd}
                className={p.cwd === picked && custom.trim() === '' ? 'proj-row on' : 'proj-row'}
                title={p.cwd}
                onClick={() => {
                  setPicked(p.cwd)
                  setCustom('')
                }}
              >
                <span className="proj-folder"><FolderIcon /></span>
                <span className="proj-name">{p.name}</span>
                <span className="proj-cwd">{p.cwd}</span>
              </div>
            ))}
          </div>
        )}
        <input
          className="proj-input"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit()
          }}
          placeholder="或输入目录路径（支持 ~/）…"
          spellCheck={false}
        />
        <div className="dialog-row">
          <button className="btn" onClick={onCancel}>取消</button>
          <button className="btn primary" disabled={cwd === null || cwd === ''} onClick={submit}>
            创建
          </button>
        </div>
      </div>
    </div>
  )
}
