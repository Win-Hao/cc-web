/** 工具审批弹窗（shadcn Dialog）：必须显式选择，点外面不关。 */
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { Approval } from '../types'
import { t, useLang } from '../lib/i18n'

interface Props {
  approval: Approval
  onDecide: (behavior: 'allow' | 'deny') => void
}

export function ApprovalDialog({ approval, onDecide }: Props) {
  useLang()
  return (
    <Dialog open>
      <DialogContent
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t('approvalTitle', { name: approval.tool_name ?? t('unknownTool') })}</DialogTitle>
        </DialogHeader>
        <pre className="max-h-60 overflow-auto rounded-lg border bg-sunken p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
          {JSON.stringify(approval.input, null, 2)}
        </pre>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onDecide('deny')}>{t('deny')}</Button>
          <Button size="sm" onClick={() => onDecide('allow')}>{t('allow')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
