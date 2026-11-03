import { useMemo, useState } from 'react'
import { FileStack, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { removeRuleProvider, saveRuleProvider } from '../lib/document'
import type { Config } from '../lib/document'
import {
  behaviorNames,
  providerTypeNames,
  ruleProviderErrors,
  ruleProviderReferences,
} from '../lib/ruleProviders'
import type { RuleProvider } from '../lib/ruleProviders'
import { Modal } from './Modal'
import { RulePreset } from './RulePreset'
import { metaRuleLabel } from '../lib/rulePresets'
import './rule-providers.css'

type Props = {
  config: Config
  disabled: boolean
  onEdit: (fn: (text: string) => string) => boolean
  onUse: (name: string) => void
  onSource: () => void
}
function sourceLabel(provider: RuleProvider) {
  if (provider.type === 'file') return provider.path || '路径未设置'
  if (provider.type === 'inline') return `${provider.payload?.length || 0} 条内联内容`
  try {
    return new URL(provider.url || '').host
  } catch {
    return '来源地址未设置'
  }
}
export function RuleProviders({ config, disabled, onEdit, onUse, onSource }: Props) {
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<{ name: string | null; value: RuleProvider } | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const providers = config['rule-providers'] || {}
  const rows = useMemo(
    () =>
      Object.entries(config['rule-providers'] || {}).map(([name, provider]) => ({
        name,
        provider,
        refs: ruleProviderReferences(config, name),
        label: metaRuleLabel(provider),
        source: sourceLabel(provider),
      })),
    [config],
  )
  const visibleRows = rows.filter(({ name, label, source }) =>
    (name + ' ' + (label || '') + ' ' + source).toLowerCase().includes(search.toLowerCase()),
  )
  const removeRefs = removing === null ? [] : ruleProviderReferences(config, removing)
  return (
    <>
      <RulePreset config={config} disabled={disabled} onEdit={onEdit} />
      <section className="panel rule-provider-section" aria-labelledby="rule-providers-heading">
        <div className="panel-heading">
          <div>
            <h2 id="rule-providers-heading">规则集 · {Object.keys(providers).length}</h2>
            <p>通过 RULE-SET 引用，应用后由 Mihomo 加载和更新。</p>
          </div>
          <button
            className="button primary small"
            disabled={disabled}
            onClick={() =>
              setEditing({
                name: null,
                value: { type: 'http', behavior: 'domain', format: 'yaml', interval: 86400 },
              })
            }
          >
            <Plus size={15} />
            添加规则集
          </button>
        </div>
        {!!Object.keys(providers).length && (
          <div className="table-toolbar">
            <div className="search-input">
              <Search size={16} />
              <input
                aria-label="搜索规则集"
                placeholder="搜索名称或来源"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <button className="text-button" onClick={onSource}>
              编辑高级字段 →
            </button>
          </div>
        )}
        {!visibleRows.length ? (
          <div className="rule-provider-empty">
            <FileStack size={24} />
            <div>
              <h3>{Object.keys(providers).length ? '没有匹配的规则集' : '暂无规则集'}</h3>
              <p>添加规则集后，再指定引用它的分流规则和目标策略。</p>
            </div>
          </div>
        ) : (
          visibleRows.map(({ name, provider, refs, label, source }) => {
            return (
              <article className="rule-provider-card" key={name} aria-label={'规则集 ' + name}>
                <div className="rule-provider-heading">
                  <div>
                    <h3>{label || name}</h3>
                    <p>
                      {label ? `${name} · ` : ''}
                      {source}
                    </p>
                  </div>
                  <span className="badge gray">{providerTypeNames[provider.type]}</span>
                  <div className="row-actions">
                    <button
                      className="button small"
                      disabled={disabled}
                      onClick={() => onUse(name)}
                      aria-label={'引用规则集 ' + name}
                    >
                      添加引用
                    </button>
                    <button
                      className="icon-button"
                      disabled={disabled}
                      onClick={() => setEditing({ name, value: provider })}
                      aria-label={'编辑规则集 ' + name}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      className="icon-button danger"
                      disabled={disabled}
                      onClick={() => setRemoving(name)}
                      aria-label={'删除规则集 ' + name}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                <dl className="rule-provider-meta">
                  <div>
                    <dt>规则行为 / 格式</dt>
                    <dd>
                      {behaviorNames[provider.behavior]} /{' '}
                      {provider.type === 'inline'
                        ? '内联列表'
                        : (provider.format || 'yaml').toUpperCase()}
                    </dd>
                  </div>
                  <div>
                    <dt>更新间隔</dt>
                    <dd>
                      {provider.type === 'http'
                        ? provider.interval === undefined
                          ? '未指定'
                          : provider.interval === 86400
                            ? '每 24 小时（86400 秒）'
                            : provider.interval + ' 秒'
                        : '不适用'}
                    </dd>
                  </div>
                  <div>
                    <dt>配置中的引用</dt>
                    <dd>{refs.map((ref) => ref.label).join('、') || '尚未引用'}</dd>
                  </div>
                  <div>
                    <dt>运行状态</dt>
                    <dd>应用后可在 Zashboard 查看</dd>
                  </div>
                </dl>
              </article>
            )
          })
        )}
      </section>
      {editing && (
        <RuleProviderDialog
          name={editing.name}
          value={editing.value}
          disabled={disabled}
          onClose={() => setEditing(null)}
          onSave={(name, value) => {
            if (onEdit((text) => saveRuleProvider(text, editing.name, name, value)))
              setEditing(null)
          }}
        />
      )}
      {removing !== null && (
        <Modal title={'删除规则集 ' + removing + '？'} onClose={() => setRemoving(null)}>
          <div className="dialog-body">
            {removeRefs.length
              ? `仍被 ${removeRefs.map((ref) => ref.label).join('、')} 使用，请先移除引用。`
              : '从草稿中移除此规则集，保存后生效。不会删除任何本地文件。'}
          </div>
          <div className="modal-actions">
            <button className="button" onClick={() => setRemoving(null)}>
              取消
            </button>
            <button
              className="button danger-button"
              disabled={disabled || !!removeRefs.length}
              onClick={() => {
                if (onEdit((text) => removeRuleProvider(text, removing))) setRemoving(null)
              }}
            >
              从草稿删除
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}

function RuleProviderDialog({
  name: original,
  value,
  disabled,
  onClose,
  onSave,
}: {
  name: string | null
  value: RuleProvider
  disabled: boolean
  onClose: () => void
  onSave: (name: string, value: RuleProvider) => void
}) {
  const [name, setName] = useState(original || '')
  const [type, setType] = useState(value.type)
  const [behavior, setBehavior] = useState(value.behavior)
  const [format, setFormat] = useState(value.format || '')
  const [url, setUrl] = useState(value.url || '')
  const [path, setPath] = useState(value.path || '')
  const [interval, setInterval] = useState(value.interval?.toString() || '')
  const [payload, setPayload] = useState((value.payload || []).join('\n'))
  const [error, setError] = useState('')
  return (
    <Modal title={original === null ? '添加规则集' : '编辑规则集'} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const provider: RuleProvider = { ...value, type, behavior }
          if (type === 'http') {
            provider.url = url.trim()
            provider.interval = interval === '' ? undefined : Number(interval)
          }
          if (type !== 'inline') {
            provider.path = path.trim() || undefined
            provider.format = format ? (format as RuleProvider['format']) : undefined
          }
          if (type === 'inline')
            provider.payload = payload
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean)
          if (original === null) {
            if (type !== 'http') {
              delete provider.url
              delete provider.interval
            }
            if (type === 'inline') {
              delete provider.path
              delete provider.format
            }
          }
          const issues = ruleProviderErrors(provider)
          if (issues.length) {
            setError(issues.join('；'))
            return
          }
          setError('')
          onSave(name, provider)
        }}
      >
        <fieldset className="modal-form rule-provider-form" disabled={disabled}>
          <label className="field">
            <span>规则集名称</span>
            <input
              aria-label="规则集名称"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：常用网站"
            />
            <small>普通 RULE-SET 引用随改名更新；复杂引用请在源码中同步修改。</small>
          </label>
          <div className="field-grid">
            <label className="field">
              <span>来源类型</span>
              <select
                aria-label="规则集来源类型"
                disabled={original !== null}
                value={type}
                onChange={(e) => setType(e.target.value as RuleProvider['type'])}
              >
                <option value="http">HTTP</option>
                <option value="file">本地文件</option>
                <option value="inline">内联内容</option>
              </select>
            </label>
            <label className="field">
              <span>规则行为</span>
              <select
                aria-label="规则集行为"
                value={behavior}
                onChange={(e) => setBehavior(e.target.value as RuleProvider['behavior'])}
              >
                <option value="domain">域名（domain）</option>
                <option value="ipcidr">IP 网段（ipcidr）</option>
                <option value="classical">经典规则（classical）</option>
              </select>
            </label>
          </div>
          {type !== 'inline' && (
            <label className="field">
              <span>数据格式</span>
              <select
                aria-label="规则集格式"
                value={format}
                onChange={(e) => setFormat(e.target.value)}
              >
                <option value="">内核默认（YAML）</option>
                <option value="yaml">YAML</option>
                <option value="text">TEXT</option>
                <option value="mrs">MRS</option>
              </select>
              <small>MRS 仅支持域名和 IP 网段，来源文件须与行为、格式一致。</small>
            </label>
          )}
          {type === 'http' && (
            <>
              <label className="field">
                <span>来源地址</span>
                <input
                  aria-label="规则集来源地址"
                  type="url"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://example.com/rules.yaml"
                />
              </label>
              <label className="field">
                <span>更新间隔（秒）</span>
                <input
                  aria-label="规则集更新间隔"
                  type="number"
                  min="0"
                  step="1"
                  value={interval}
                  onChange={(e) => setInterval(e.target.value)}
                  placeholder="留空不指定"
                />
                <small>应用到内核后，由 Mihomo 按此间隔更新。</small>
              </label>
            </>
          )}
          {type !== 'inline' && (
            <label className="field">
              <span>{type === 'file' ? '文件路径' : '缓存路径（可选）'}</span>
              <input
                aria-label="规则集文件路径"
                value={path}
                required={type === 'file'}
                onChange={(e) => setPath(e.target.value)}
                placeholder="./rules/example.yaml"
              />
              <small>
                {type === 'file'
                  ? '填写内核运行环境中的路径，当前不会读取该文件。'
                  : '留空由 Mihomo 根据 URL 生成缓存文件名。路径不能与其他规则集重复。'}
              </small>
            </label>
          )}
          {type === 'inline' && (
            <label className="field">
              <span>内联规则内容</span>
              <textarea
                aria-label="内联规则内容"
                rows={6}
                value={payload}
                onChange={(e) => setPayload(e.target.value)}
                placeholder={
                  behavior === 'classical'
                    ? 'DOMAIN-SUFFIX,example.com'
                    : behavior === 'ipcidr'
                      ? '192.0.2.0/24'
                      : '+.example.com'
                }
              />
              <small>每行一条匹配内容，不填写目标策略；目标在分流规则中设置。</small>
            </label>
          )}
          {error && (
            <p className="rule-provider-error" role="alert">
              {error}
            </p>
          )}
        </fieldset>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="button primary" disabled={disabled}>
            {original === null ? '添加到草稿' : '更新草稿'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
