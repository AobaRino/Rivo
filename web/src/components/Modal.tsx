import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
export function Modal({
  title,
  children,
  onClose,
  size = 'standard',
}: {
  title: string
  children: ReactNode
  onClose: () => void
  size?: 'standard' | 'medium' | 'large' | 'wide'
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement
    const old = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    ref.current?.focus({ preventScroll: true })
    return () => {
      document.body.style.overflow = old
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        className={`modal modal-${size}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={(e) => {
          if (e.defaultPrevented) return
          if (e.key === 'Escape') {
            e.stopPropagation()
            // Monaco uses Escape for completion, hover, search and diagnostics.
            // Do not discard the entire node draft while dismissing those widgets.
            if ((e.target as HTMLElement).closest('.monaco-editor')) return
            onClose()
            return
          }
          if (e.key !== 'Tab') return
          const items = Array.from(
            ref.current!.querySelectorAll<HTMLElement>(
              'button:not(:disabled),input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
            ),
          ).filter((item) => item.getClientRects().length > 0 && !item.closest('[hidden]'))
          const first = items[0],
            last = items.at(-1)
          if (
            e.shiftKey &&
            (document.activeElement === first || document.activeElement === ref.current)
          ) {
            e.preventDefault()
            last?.focus()
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault()
            first?.focus()
          }
        }}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button type="button" className="icon-button" aria-label="关闭对话框" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}
