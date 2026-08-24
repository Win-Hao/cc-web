import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs whitespace-nowrap transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-secondary text-muted-foreground',
        accent: 'bg-accent text-accent-foreground',
        warning: 'bg-warning-soft text-warning',
        destructive: 'bg-danger-soft text-destructive',
        outline: 'border border-accent-bd bg-accent text-accent-foreground',
      },
    },
    defaultVariants: { variant: 'default' },
  },
)

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
