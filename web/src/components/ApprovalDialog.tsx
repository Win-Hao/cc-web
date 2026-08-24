/** 工具审批弹窗：圆角卡 + 大阴影；拒绝为默认视觉焦点之外的次级按钮。 */
import type { Approval } from '../types'

interface Props {
  approval: Approval
  onDecide: (behavior: 'allow' | 'deny') => void
}

export function ApprovalDialog({ approval, onDecide }: Props) {
  return (
    <div className="backdrop">
      <div className="dialog">
        <h3>工具审批：{approval.tool_name ?? '未知工具'}</h3>
        <pre>{JSON.stringify(approval.input, null, 2)}</pre>
        <div className="dialog-row">
          <button className="btn" onClick={() => onDecide('deny')}>拒绝</button>
          <button className="btn primary" onClick={() => onDecide('allow')}>允许</button>
        </div>
      </div>
    </div>
  )
}
