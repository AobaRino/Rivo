import { useMemo, useState } from 'react'
import type { RJSFSchema } from '@rjsf/utils'
import { Modal } from './Modal'
import { SchemaFields } from './SchemaFields'
import { fieldCatalog, sectionItemSchema, sectionSchema, schemaProblems } from '../lib/mihomoSchema'
import type { Config, Path } from '../lib/document'
import { useSchemaSnapshot } from '../lib/schemaStore'

type Target = {
  id: string
  label: string
  path: Path
  definition: RJSFSchema
  value: Record<string, unknown>
}
const sections = {
  general: '通用设置',
  dns: 'DNS',
  tun: 'TUN',
  sniffer: '流量嗅探',
  profile: '配置持久化',
  ntp: 'NTP',
  tls: '全局 TLS',
  experimental: '实验设置',
  'tuic-server': 'TUIC 服务',
}
export default function ConfigFieldsDialog({
  config,
  initial,
  onSave,
  onClose,
}: {
  config: Config
  initial: string
  onSave: (path: Path, value: Record<string, unknown>) => boolean
  onClose: () => void
}) {
  const schemaSnapshot = useSchemaSnapshot()
  const targets = useMemo(() => {
    const list: Target[] = Object.entries(sections).map(([key, label]) => {
      const definition = sectionSchema(key)
      const value =
        key === 'general'
          ? Object.fromEntries(
              Object.entries(config).filter(([k]) =>
                Object.hasOwn(fieldCatalog(definition).properties || {}, k),
              ),
            )
          : ((config[key] || {}) as Record<string, unknown>)
      return { id: key, label, path: key === 'general' ? [] : [key], definition, value }
    })
    for (const [index, group] of (config['proxy-groups'] || []).entries())
      list.push({
        id: `group-${index}`,
        label: `代理组 / ${group.name}`,
        path: ['proxy-groups', index],
        definition: sectionItemSchema('proxy-groups', group.type),
        value: group,
      })
    for (const section of ['proxy-providers', 'rule-providers'] as const)
      for (const [name, provider] of Object.entries(config[section] || {}))
        list.push({
          id: `${section}-${name}`,
          label: `${section === 'proxy-providers' ? '订阅' : '规则集'} / ${name}`,
          path: [section, name],
          definition: sectionItemSchema(section),
          value: provider,
        })
    return list
  }, [config, schemaSnapshot])
  const [selected, setSelected] = useState(
    targets.some((t) => t.id === initial) ? initial : 'general',
  )
  const target = targets.find((t) => t.id === selected)!
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({})
  const value = drafts[selected] || target.value
  const definition =
    target.path[0] === 'proxy-groups'
      ? sectionItemSchema('proxy-groups', String(value.type))
      : target.definition
  const problems = useMemo(() => schemaProblems(definition, value), [definition, value])
  return (
    <Modal title="更多配置字段" size="medium" onClose={onClose}>
      <div className="config-fields-toolbar">
        <label className="control-row">
          <span>配置块</span>
          <select
            aria-label="配置块"
            value={selected}
            disabled={JSON.stringify(value) !== JSON.stringify(target.value)}
            onChange={(e) => setSelected(e.target.value)}
          >
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
                {drafts[t.id] ? ' · 已编辑' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="schema-editor-scroll">
        <p className="schema-note">
          编辑所选配置块的原生字段。更新草稿后，在页面顶部预览并确认保存。
        </p>
        <SchemaFields
          key={selected}
          schema={definition}
          value={value}
          onChange={(next) => setDrafts((previous) => ({ ...previous, [selected]: next }))}
        />
        {!!problems.length && (
          <details className="schema-diagnostics">
            <summary>Schema 提示（{problems.length}）</summary>
            <ul>
              {problems.slice(0, 12).map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <div className="modal-actions">
        <span className="modal-hint">仅更新当前所选配置块</span>
        <button className="button" onClick={onClose}>
          取消
        </button>
        <button
          className="button primary"
          onClick={() => {
            let updated = value
            if (!target.path.length) {
              updated = { ...config }
              for (const key of Object.keys(target.value)) delete updated[key]
              Object.assign(updated, value)
            }
            if (onSave(target.path, updated)) onClose()
          }}
        >
          更新草稿
        </button>
      </div>
    </Modal>
  )
}
