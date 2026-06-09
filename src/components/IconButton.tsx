import * as Tooltip from '@radix-ui/react-tooltip'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from '../lib/format'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  children: ReactNode
  text?: string
  variant?: 'ghost' | 'solid' | 'danger'
}

export function IconButton({
  label,
  children,
  text,
  variant = 'ghost',
  className,
  ...props
}: IconButtonProps) {
  const variants = {
    ghost: 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50 hover:text-slate-900',
    solid: 'border-slate-900 bg-slate-900 text-white hover:bg-slate-800',
    danger: 'border-rose-200 bg-white text-rose-700 hover:bg-rose-50',
  }

  return (
    <Tooltip.Provider delayDuration={250}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            aria-label={label}
            className={cx(
              'inline-flex h-8 items-center justify-center gap-2 rounded border px-2.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-45',
              variants[variant],
              !text && 'w-8 px-0',
              className,
            )}
            {...props}
          >
            {children}
            {text ? <span className="truncate">{text}</span> : null}
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="bottom"
            className="z-50 rounded border border-slate-800 bg-slate-950 px-2 py-1 text-[11px] text-white"
          >
            {label}
            <Tooltip.Arrow className="fill-slate-950" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  )
}
