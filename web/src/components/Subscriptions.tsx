import { useState } from 'react'
import { Eye, EyeOff, Pencil, Plus, Rss, Search, Trash2 } from 'lucide-react'
import { removeProvider, saveProvider } from '../lib/document'
import type { Group, Provider } from '../lib/document'
import { Modal } from './Modal'
import './subscriptions.css'

type Props = {
  managed?: boolean
  providers: Record<string, Provider>
  groups: Group[]
  disabled: boolean
  onEdit: (fn: (text: string) => string) => boolean
  onSource: () => void
}
function host(provider: Provider) {
  try {
    return new URL(provider.url || '').hostname
  } catch {
    return provider.type === 'http' ? '链接未设置' : provider.type + ' 集合'
  }
}
export function Subscriptions({ providers, groups, disabled, onEdit, onSource, managed }: Props) {
  const [editing, setEditing] = useState<{
    original: string | null
    name: string
    value: Provider
  } | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const names = Object.keys(providers).filter((name) =>
    (name + ' ' + host(providers[name])).toLowerCase().includes(search.toLowerCase()),
  )
  const add = () =>
    setEditing({ original: null, name: '', value: { type: 'http', url: '', interval: 3600 } })
  return (
    <>
      <section className="panel subscription-section" aria-labelledby="subscriptions-heading">
        <div className="panel-heading">
          <div>
            <h2 id="subscriptions-heading">订阅 · {Object.keys(providers).length}</h2>
            <p>
              {managed
                ? '由 Mihomo 下载和更新。下方显示已应用订阅的加载状态。'
                : '由 Mihomo 下载和更新。当前本地预览不加载订阅节点。'}
            </p>
          </div>
          <button className="button primary small" disabled={disabled} onClick={add}>
            <Plus size={15} />
            添加订阅
          </button>
        </div>
        {Object.keys(providers).length > 0 && (
          <div className="table-toolbar subscription-toolbar">
            <div className="search-input">
              <Search size={16} />
              <input
                aria-label="搜索订阅"
                placeholder="搜索订阅名称或域名"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
        )}
        {!names.length ? (
          <div className="subscription-empty">
            <Rss size={22} />
            <h3>{Object.keys(providers).length ? '没有匹配的订阅' : '暂无订阅'}</h3>
            <p>添加订阅链接后，可在代理组中使用该订阅。</p>
          </div>
        ) : (
          <div className="subscription-list">
            {names.map((name) => {
              const provider = providers[name]
              const used = groups
                .filter((group) => group.use?.includes(name))
                .map((group) => group.name)
              return (
                <section className="subscription-card" key={name}>
                  <div className="subscription-heading">
                    <div className="subscription-name">
                      <span className="subscription-icon">
                        <Rss size={19} />
                      </span>
                      <div>
                        <h3>{name}</h3>
                        <p>{host(provider)}</p>
                      </div>
                    </div>
                    <span className="badge gray">{provider.type.toUpperCase()}</span>
                    <div className="row-actions">
                      <button
                        className="icon-button"
                        aria-label={'编辑订阅 ' + name}
                        disabled={disabled}
                        onClick={() =>
                          provider.type === 'http'
                            ? setEditing({ original: name, name, value: { ...provider } })
                            : onSource()
                        }
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        className="icon-button danger"
                        aria-label={'删除订阅 ' + name}
                        disabled={disabled}
                        onClick={() => setRemoving(name)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                  <dl className="subscription-meta">
                    <div>
                      <dt>更新间隔</dt>
                      <dd>
                        {provider.interval === undefined ? '未设置' : provider.interval + ' 秒'}
                      </dd>
                    </div>
                    <div>
                      <dt>使用此订阅的代理组</dt>
                      <dd>{used.join('、') || '未分配'}</dd>
                    </div>
                  </dl>
                </section>
              )
            })}
          </div>
        )}
      </section>
      {editing && (
        <ProviderDialog
          value={editing.value}
          name={editing.name}
          existing={editing.original !== null}
          onClose={() => setEditing(null)}
          onSave={(name, value) => {
            if (onEdit((t) => saveProvider(t, editing.original, name, value))) setEditing(null)
          }}
        />
      )}
      {removing !== null && (
        <Modal title={'删除订阅 ' + removing + '？'} onClose={() => setRemoving(null)}>
          <div className="dialog-body">从草稿中移除此订阅。被代理组引用的订阅需要先取消引用。</div>
          <div className="modal-actions">
            <button className="button" onClick={() => setRemoving(null)}>
              取消
            </button>
            <button
              className="button danger-button"
              onClick={() => {
                if (onEdit((t) => removeProvider(t, removing))) setRemoving(null)
              }}
            >
              删除订阅
            </button>
          </div>
        </Modal>
      )}
    </>
  )
}
function ProviderDialog({
  value,
  name: initial,
  existing,
  onClose,
  onSave,
}: {
  value: Provider
  name: string
  existing: boolean
  onClose: () => void
  onSave: (name: string, value: Provider) => void
}) {
  const [name, setName] = useState(initial)
  const [provider, setProvider] = useState<Provider>({ ...value })
  const [visible, setVisible] = useState(false)
  return (
    <Modal title={existing ? '编辑订阅' : '添加订阅'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          onSave(name, provider)
        }}
      >
        <div className="modal-form">
          <label className="field">
            <span>订阅名称</span>
            <input
              aria-label="订阅名称"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：机场 A"
            />
          </label>
          <label className="field">
            <span>订阅链接</span>
            <div className="secret-input">
              <input
                aria-label="订阅链接"
                required
                type={visible ? 'text' : 'password'}
                autoComplete="off"
                value={provider.url || ''}
                onChange={(e) => setProvider({ ...provider, url: e.target.value })}
                placeholder="https://…"
              />
              <button
                type="button"
                className="icon-button"
                aria-label={visible ? '隐藏订阅链接' : '显示订阅链接'}
                onClick={() => setVisible(!visible)}
              >
                {visible ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <small>填写服务商提供的订阅链接，由 Mihomo 加载。</small>
          </label>
          <label className="field">
            <span>更新间隔（秒）</span>
            <input
              aria-label="订阅更新间隔"
              type="number"
              min="0"
              step="1"
              value={provider.interval ?? ''}
              onChange={(e) =>
                setProvider({
                  ...provider,
                  interval: e.target.value === '' ? undefined : Number(e.target.value),
                })
              }
            />
            <small>由 Mihomo 按此间隔更新，留空则不设置此字段。</small>
          </label>
        </div>
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="button primary">
            {existing ? '更新草稿' : '添加到草稿'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
