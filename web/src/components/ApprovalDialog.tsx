/** 工具审批弹窗（shadcn Dialog）：必须显式选择，点外面不关。 */
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { Approval } from '../types'

interface Props {
  approval: Approval
  onDecide: (behavior: 'allow' | 'deny') => void
}

export function ApprovalDialog({ approval, onDecide }: Props) {
  return (
    <Dialog open>
      <DialogContent
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>工具审批：{approval.tool_name ?? '未知工具'}</DialogTitle>
        </DialogHeader>
        <pre className="max-h-60 overflow-auto rounded-lg border bg-sunken p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
          {JSON.stringify(approval.input, null, 2)}
        </pre>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onDecide('deny')}>拒绝</Button>
          <Button size="sm" onClick={() => onDecide('allow')}>允许</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
