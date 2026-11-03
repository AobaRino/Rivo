import { useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import type { Config } from '../lib/document'
import {
  deleteDirectException,
  directException,
  directTypes,
  makeDirectException,
  saveDirectException,
  type DirectType,
} from '../lib/directExceptions'
import { Modal } from './Modal'

type Row = { index: number; value: string }
export function DirectExceptions({
  config,
  disabled,
  onEdit,
}: {
  config: Config
  disabled: boolean
  onEdit: (edit: (text: string) => string) => boolean
}) {
  const [editing, setEditing] = useState<{ original: Row | null } | null>(null)
  const [removing, setRemoving] = useState<Row | null>(null)
  const rows = (config.rules || []).flatMap((value, index) => {
    const parsed = directException(value)
    return parsed ? [{ ...parsed, index, value }] : []
  })
  return (
    <>
      <section className="panel" aria-label="直连例外">
        <div className="panel-heading">
          <div>
            <h2>直连例外 · {rows.length}</h2>
            <p>手动指定直连的域名、IP 和网段。新增项放在规则最前面，使用规则模式时生效。</p>
          </div>
          <button
            className="button primary small"
            disabled={disabled}
            onClick={() => setEditing({ original: null })}
          >
            <Plus size={15} />
            添加直连例外
          </button>
        </div>
        {rows.length ? (
          <div className="table-scroll">
            <table className="rules-table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>匹配内容</th>
                  <th>规则位置</th>
                  <th className="right">操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.index}>
                    <td>{directTypes[row.type]}</td>
                    <td className="mono">{row.match}</td>
                    <td>第 {row.index + 1} 条</td>
                    <td>
                      <div className="row-actions">
                        <button
                          className="icon-button"
                          aria-label={`编辑直连例外 ${row.match}`}
                          disabled={disabled}
                          onClick={() => setEditing({ original: row })}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          className="icon-button danger"
                          aria-label={`删除直连例外 ${row.match}`}
                          disabled={disabled}
                          onClick={() => setRemoving(row)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rule-provider-empty">
            暂无手动直连例外。国内直连规则集和服务分组仍按下方配置生效。
          </div>
        )}
      </section>
      {editing && (
        <DirectExceptionDialog
          original={editing.original}
          disabled={disabled}
          onClose={() => setEditing(null)}
          onSave={(value) => {
            if (onEdit((text) => saveDirectException(text, editing.original, value)))
              setEditing(null)
          }}
        />
      )}
      {removing && (
        <Modal title="删除直连例外？" onClose={() => setRemoving(null)}>
          <div className="dialog-body">
            {directException(removing.value)?.match} 将恢复按其他分流规则匹配。保存并应用后生效。
          </div>
          <div className="modal-actions">
            <button className="button" onClick={() => setRemoving(null)}>
              取消
            </button>
            <button
              className="button danger-button"
              disabled={disabled}
              onClick={() => {
                if (onEdit((text) => deleteDirectException(text, removing.index, removing.value)))
                  setRemoving(null)
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

function DirectExceptionDialog({
  original,
  disabled,
  onClose,
  onSave,
}: {
  original: Row | null
  disabled: boolean
  onClose: () => void
  onSave: (value: string) => void
}) {
  const initial = original && directException(original.value)
  const [type, setType] = useState<DirectType>(initial?.type || 'DOMAIN-SUFFIX')
  const [match, setMatch] = useState(initial?.match || '')
  const [noResolve, setNoResolve] = useState(initial?.noResolve || false)
  const [error, setError] = useState('')
  const ip = type === 'IP-CIDR' || type === 'IP-CIDR6'
  let preview = ''
  try {
    preview = makeDirectException(type, match, noResolve)
  } catch {
    /* Display validation on submit. */
  }
  return (
    <Modal title={original ? '编辑直连例外' : '添加直连例外'} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          try {
            onSave(makeDirectException(type, match, noResolve))
          } catch (e) {
            setError((e as Error).message)
          }
        }}
      >
        <fieldset className="modal-form rule-provider-form" disabled={disabled}>
          <label className="field">
            <span>匹配方式</span>
            <select
              aria-label="直连匹配方式"
              value={type}
              onChange={(e) => {
                setType(e.target.value as DirectType)
                setError('')
              }}
            >
              {Object.entries(directTypes).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{ip ? 'IP 地址或网段' : '域名'}</span>
            <input
              aria-label="直连匹配内容"
              autoComplete="off"
              spellCheck={false}
              required
              value={match}
              onChange={(e) => {
                setMatch(e.target.value)
                setError('')
              }}
              placeholder={
                type === 'IP-CIDR6'
                  ? '2001:db8::/32'
                  : ip
                    ? '192.168.1.0/24'
                    : 'example.com 或 *.example.com'
              }
            />
            <small>
              {type === 'DOMAIN-SUFFIX'
                ? '例如 home.example.com：匹配这个域名及其所有子域名。'
                : type === 'DOMAIN'
                  ? '只匹配填写的完整域名，不包括子域名。'
                  : '不带前缀长度时只匹配该 IP。IPv6 规则需要内核和网络已启用 IPv6。'}
            </small>
          </label>
          {ip && (
            <label className="checkbox-line">
              <input
                type="checkbox"
                checked={noResolve}
                onChange={(e) => setNoResolve(e.target.checked)}
              />
              不额外解析域名（no-resolve）
            </label>
          )}
          {preview && <code className="rule-preview">{preview}</code>}
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
          <button className="button primary" disabled={disabled}>
            {original ? '更新草稿' : '添加到草稿'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
