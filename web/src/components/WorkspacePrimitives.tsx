import { useEffect, useState, type ReactNode, type MouseEventHandler } from 'react'
import { Search, Check, type LucideIcon } from 'lucide-react'
export const modeNames: Record<string, string> = { rule: '规则', global: '全局', direct: '直连' }
export function timeLabel(value?: string) {
  return value
    ? new Date(value).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—'
}
export function Badge({ children, tone = 'green' }: { children: ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>
}
export function IconButton({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  danger = false,
  outlined = false,
  title = label,
}: {
  icon: LucideIcon
  label: string
  onClick: MouseEventHandler<HTMLButtonElement>
  disabled?: boolean
  danger?: boolean
  outlined?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      className={`${outlined ? 'button icon' : 'icon-button'}${danger ? ' danger' : ''}`}
      title={title}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  )
}
export function Panel({
  title,
  description,
  action,
  children,
  className = '',
}: {
  title: string
  description?: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}
export function Empty({
  icon: Icon = Search,
  title,
  description,
  action,
}: {
  icon?: LucideIcon
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={24} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  )
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </div>
  )
}
export function TextField({
  value,
  onCommit,
  type = 'text',
  label,
  placeholder,
}: {
  value: string | number
  onCommit: (v: string) => void
  type?: string
  label: string
  placeholder?: string
}) {
  const [local, setLocal] = useState(String(value))
  useEffect(() => setLocal(String(value)), [value])
  return (
    <input
      aria-label={label}
      type={type}
      value={local}
      placeholder={placeholder}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={() => {
        if (local !== String(value)) onCommit(local)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}
export function Switch({
  value,
  onChange,
  label,
}: {
  value: boolean | undefined
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      role="switch"
      aria-checked={!!value}
      onClick={() => onChange(!value)}
      className={`switch ${value ? 'on' : ''}`}
    >
      <span />
    </button>
  )
}
export function ModeControl({
  value,
  onChange,
  disabled = false,
  label = '代理模式',
  className = '',
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  label?: string
  className?: string
}) {
  return (
    <div className={`segmented ${className}`} role="group" aria-label={label}>
      {Object.entries(modeNames).map(([key, label]) => (
        <button
          type="button"
          disabled={disabled}
          key={key}
          aria-pressed={value === key}
          aria-label={label}
          onClick={() => onChange(key)}
        >
          {key === value && <Check size={13} aria-hidden="true" />}
          {label}
        </button>
      ))}
    </div>
  )
}
