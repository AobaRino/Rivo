import { lazy, Suspense, useRef, useState } from 'react'
import { Copy, FileCode2, Pencil, Plus, Trash2, Upload } from 'lucide-react'
import { api } from '../lib/api'
import type { ProfileSummary, State } from '../lib/api'
import { Modal } from './Modal'
import { ChangeSummary } from './ChangeSummary'
const DiffEditor = lazy(() => import('./DiffEditor'))
const emptyConfig =
  '# 新建配置，编辑后可在首页切换。\nmode: rule\nmixed-port: 7890\nproxies: []\nproxy-groups: []\nrules:\n  - MATCH,DIRECT\n'
type Edit = {
  kind: 'create' | 'rename' | 'delete'
  name: string
  text: string
  id?: string
  expected: string
  review: boolean
}
export function ProfileLibrary({
  state,
  disabled,
  onUpdate,
  onSwitch,
  onEdit,
}: {
  state: State
  disabled: boolean
  onUpdate: (state: State) => void
  onSwitch: (id: string) => void
  onEdit: () => void
}) {
  const [edit, setEdit] = useState<Edit | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const file = useRef<HTMLInputElement>(null)
  const open = (kind: Edit['kind'], name: string, text = '', id?: string) => {
    setError('')
    setEdit({
      kind,
      name,
      text,
      id,
      expected: state.profilesRevision || '',
      review: kind === 'delete',
    })
  }
  const save = async () => {
    if (!edit) return
    setBusy(true)
    setError('')
    try {
      const next =
        edit.kind === 'create'
          ? await api.createProfile(edit.name, edit.text, edit.expected)
          : edit.kind === 'rename'
            ? await api.renameProfile(edit.id!, edit.name, edit.expected)
            : await api.deleteProfile(edit.id!, edit.expected)
      onUpdate(next)
      setEdit(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const duplicate = async (p: ProfileSummary) => {
    setBusy(true)
    setError('')
    try {
      const { profile, profilesRevision } = await api.profile(p.id)
      setEdit({
        kind: 'create',
        name: p.name.replace(/\.ya?ml$/i, '') + '-副本.yaml',
        text: profile.draft,
        expected: profilesRevision,
        review: false,
      })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="home-panel profile-library" aria-label="配置管理">
      <div className="home-section-heading">
        <div>
          <h2>配置文件</h2>
          <p className="home-muted">每份配置保留独立草稿和修订记录，切换前预览并检查。</p>
        </div>
        <div className="action-row">
          <button
            className="button"
            disabled={disabled || busy}
            onClick={() => file.current?.click()}
          >
            <Upload size={14} />
            导入为新配置
          </button>
          <button
            className="button primary"
            disabled={disabled || busy}
            onClick={() => open('create', '新配置.yaml', emptyConfig)}
          >
            <Plus size={14} />
            新建配置
          </button>
        </div>
      </div>
      <input
        ref={file}
        type="file"
        hidden
        accept=".yaml,.yml,.txt"
        onChange={async (e) => {
          const input = e.currentTarget
          const f = input.files?.[0]
          input.value = ''
          if (!f) return
          if (f.size > 2 * 1024 * 1024) {
            setError('配置不能超过 2 MB')
            return
          }
          try {
            open('create', f.name, await f.text())
          } catch {
            setError('无法读取文件')
          }
        }}
      />
      {error && !edit && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {!state.profiles && <p className="quiet-note">多配置管理当前仅在本地模拟环境开放。</p>}
      <div className="profile-list">
        {state.profiles?.map((p) => (
          <div key={p.id} className={`profile-row ${p.id === state.profileID ? 'current' : ''}`}>
            <FileCode2 size={22} />
            <div className="profile-row-info">
              <strong>{p.name}</strong>
              {p.id === state.profileID && (
                <>
                  {' '}
                  <span className="home-badge">当前使用</span>
                </>
              )}
              <small>保存于 {new Date(p.savedAt).toLocaleString('zh-CN')}</small>
            </div>
            <div className="action-row">
              {p.id === state.profileID ? (
                <button className="button" onClick={onEdit}>
                  编辑
                </button>
              ) : (
                <button
                  className="button"
                  disabled={disabled || busy}
                  onClick={() => onSwitch(p.id)}
                >
                  切换
                </button>
              )}
              <button
                className="button"
                aria-label={`复制 ${p.name}`}
                disabled={disabled || busy}
                onClick={() => void duplicate(p)}
              >
                <Copy size={13} />
                复制
              </button>
              <button
                className="icon-button"
                aria-label={`重命名 ${p.name}`}
                disabled={disabled || busy}
                onClick={() => open('rename', p.name, '', p.id)}
              >
                <Pencil size={14} />
              </button>
              <button
                className="icon-button danger"
                aria-label={`删除 ${p.name}`}
                disabled={disabled || busy || p.id === state.profileID}
                onClick={() => open('delete', p.name, '', p.id)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
      {edit && (
        <Modal
          title={
            edit.kind === 'delete'
              ? '删除配置'
              : edit.kind === 'rename'
                ? '重命名配置'
                : edit.review
                  ? '创建配置前预览'
                  : '新建配置'
          }
          size={edit.kind === 'create' && edit.review ? 'wide' : 'standard'}
          onClose={() => !busy && setEdit(null)}
        >
          {edit.kind === 'delete' ? (
            <div className="dialog-body">
              <p>
                删除 <strong>{edit.name}</strong> 及其本地修订记录。当前使用的配置不受影响。
              </p>
            </div>
          ) : edit.review ? (
            <div className="save-review">
              <div className="dialog-body">
                将创建 <strong>{edit.name}</strong>，当前运行配置保持不变。
              </div>
              <ChangeSummary before="" after={edit.text} />
              <Suspense fallback={<div className="quiet-note">正在加载 YAML 差异…</div>}>
                <DiffEditor before="" after={edit.text} />
              </Suspense>
            </div>
          ) : (
            <div className="modal-form profile-form">
              <label className="field">
                <span>配置名称</span>
                <input
                  aria-label="配置名称"
                  value={edit.name}
                  maxLength={80}
                  onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                />
              </label>
              {edit.kind === 'create' && (
                <label className="field">
                  <span>初始 YAML</span>
                  <textarea
                    aria-label="初始 YAML"
                    value={edit.text}
                    spellCheck={false}
                    onChange={(e) => setEdit({ ...edit, text: e.target.value })}
                  />
                </label>
              )}
              <p className="home-muted">
                {edit.kind === 'rename'
                  ? '仅修改名称，不改变 YAML 与运行状态。'
                  : '创建后可编辑节点、规则和 DNS，确认切换后才模拟应用。'}
              </p>
            </div>
          )}
          {error && (
            <div className="save-review-error" role="alert">
              {error}
            </div>
          )}
          <div className="modal-actions">
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                edit.review && edit.kind === 'create'
                  ? setEdit({ ...edit, review: false })
                  : setEdit(null)
              }
            >
              {edit.review && edit.kind === 'create' ? '返回编辑' : '取消'}
            </button>
            <button
              className={`button ${edit.kind === 'delete' ? 'danger-button' : 'primary'}`}
              disabled={busy || !edit.name.trim()}
              onClick={() =>
                edit.kind === 'create' && !edit.review
                  ? setEdit({ ...edit, review: true })
                  : void save()
              }
            >
              {busy
                ? '处理中…'
                : edit.kind === 'delete'
                  ? '确认删除'
                  : edit.kind === 'rename'
                    ? '确认重命名'
                    : edit.review
                      ? '确认创建'
                      : '预览并创建'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  )
}
