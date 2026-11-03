import { useState } from 'react'
import { Search } from 'lucide-react'
import { serviceRules } from '../lib/serviceRules'
import type { ServiceSelections } from '../lib/serviceRules'

export function ServicePicker({
  selected,
  onChange,
  exits,
  proxy,
  disabled,
}: {
  selected: ServiceSelections
  onChange: (value: ServiceSelections) => void
  exits: string[]
  proxy: string
  disabled: boolean
}) {
  const [search, setSearch] = useState('')
  const categories = [...new Set(serviceRules.map((service) => service.category))]
  const visible = serviceRules.filter((service) =>
    `${service.name} ${service.category} ${service.description}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  )
  const choose = (ids: string[]) =>
    onChange({
      ...selected,
      ...Object.fromEntries(
        serviceRules
          .filter((service) => ids.includes(service.id))
          .map((service) => [
            service.id,
            selected[service.id] ?? (service.direct ? 'DIRECT' : proxy),
          ]),
      ),
    })
  return (
    <section className="service-picker" aria-label="选择服务分组">
      <div className="service-picker-heading">
        <div>
          <h3>服务分组</h3>
          <p>勾选后生成独立策略组。默认出口写入配置，运行时也可在 Zashboard 中切换。</p>
        </div>
        <span>
          已选 {Object.keys(selected).length} / {serviceRules.length}
        </span>
      </div>
      <div className="service-picker-tools">
        <div className="search-input">
          <Search size={15} />
          <input
            aria-label="搜索服务分组"
            placeholder="搜索服务或分类"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="action-row">
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            onClick={() => choose(serviceRules.filter((s) => s.common).map((s) => s.id))}
          >
            勾选常用
          </button>
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            onClick={() => choose(serviceRules.map((s) => s.id))}
          >
            全选
          </button>
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            onClick={() => onChange({})}
          >
            清空
          </button>
        </div>
      </div>
      {categories.map((category) => {
        const entries = visible.filter((service) => service.category === category)
        if (!entries.length) return null
        return (
          <fieldset className="service-category" key={category} disabled={disabled}>
            <legend>{category}</legend>
            {entries.map((service) => {
              const checked = Object.hasOwn(selected, service.id)
              const value = selected[service.id] ?? (service.direct ? 'DIRECT' : proxy)
              return (
                <div className={`service-picker-row${checked ? ' selected' : ''}`} key={service.id}>
                  <label className="service-picker-check">
                    <input
                      type="checkbox"
                      aria-label={`启用 ${service.name} 分组`}
                      checked={checked}
                      onChange={(e) => {
                        if (e.target.checked) choose([service.id])
                        else {
                          const next = { ...selected }
                          delete next[service.id]
                          onChange(next)
                        }
                      }}
                    />
                    <span>
                      <strong>{service.name}</strong>
                      <small>{service.description}</small>
                    </span>
                  </label>
                  <label className="field service-picker-exit">
                    <span>默认出口</span>
                    <select
                      aria-label={`${service.name} 默认出口`}
                      disabled={!checked}
                      value={value}
                      onChange={(e) => onChange({ ...selected, [service.id]: e.target.value })}
                    >
                      {!exits.includes(value) && (
                        <option value={value}>{value || '请选择出口'}（不可用）</option>
                      )}
                      {exits.map((exit) => (
                        <option key={exit} value={exit}>
                          {exit === 'DIRECT' ? 'DIRECT · 直连' : exit}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )
            })}
          </fieldset>
        )
      })}
      {!visible.length && <p className="rule-preset-note">没有匹配的服务分组。</p>}
    </section>
  )
}
