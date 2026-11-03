import { useEffect, useState } from 'react'
import { Cpu, RefreshCw } from 'lucide-react'
import { Modal } from './Modal'
import { refreshCoreSchema } from '../lib/schemaStore'
import { apiFetch, routerMode } from '../lib/transport'

type Bundle = {
  id: string
  version: string
  schemaVersion: string
  schemaWarning?: string
  releaseDigest: string
}
type Status = {
  enabled: boolean
  reason?: string
  platform?: string
  running: boolean
  busy: boolean
  current?: Bundle
  previous?: Bundle
  prepared?: Bundle
  operation?: { kind: string; phase: string; status: string; error?: string }
}
type Release = { version: string; published: string; asset: string }
async function request<T>(path: string, body?: object): Promise<T> {
  const response = await apiFetch(`/api/core${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || '内核操作失败')
  return result
}

export function CoreManager() {
  const [status, setStatus] = useState<Status>()
  const [releases, setReleases] = useState<Release[]>([])
  const [selected, setSelected] = useState('')
  const [requesting, setRequesting] = useState(false)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState<{
    action: 'activate' | 'rollback'
    target: Bundle
    expected: string
  }>()
  useEffect(() => {
    let disposed = false,
      loading = false
    async function refresh() {
      if (loading) return
      loading = true
      try {
        const next = await request<Status>('')
        if (!disposed) setStatus(next)
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : '读取内核状态失败')
      } finally {
        loading = false
      }
    }
    void refresh()
    const timer = window.setInterval(refresh, 1500)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [])
  const busy = requesting || status?.busy || !status?.enabled
  async function run(action: 'prepare' | 'activate' | 'rollback', body: object) {
    setRequesting(true)
    setError('')
    try {
      setStatus(await request<Status>(`/${action}`, body))
      setConfirm(undefined)
      void refreshCoreSchema()
    } catch (e) {
      setError(e instanceof Error ? e.message : '内核操作失败')
    } finally {
      setRequesting(false)
    }
  }
  return (
    <section className="panel" aria-labelledby="core-heading">
      <div className="panel-heading">
        <div>
          <h2 id="core-heading">Mihomo 内核</h2>
          <p>
            {routerMode
              ? '内核由 procd 管理。配置应用会先校验，失败自动回退；此路由器版本暂不开放在线切换内核版本。'
              : '内核与提示规则一起更新，回退时恢复对应的 Schema。'}
          </p>
        </div>
        <span className={`badge ${status?.running ? 'green' : 'gray'}`}>
          {status?.running ? '运行中' : status?.enabled ? '未运行' : '未启用托管'}
        </span>
      </div>
      <div className="resource-core">
        <Cpu size={30} strokeWidth={1.4} />
        <div>
          <strong>{status?.current?.version || '尚未安装托管内核'}</strong>
          <p>
            {status?.enabled
              ? `${status.platform} · Schema ${status.current?.schemaVersion || '1.19.32（内置）'}`
              : status?.reason || '正在读取状态…'}
          </p>
        </div>
        <div className="action-row resource-core-actions">
          <button
            className="button small"
            disabled={busy || routerMode}
            onClick={async () => {
              setRequesting(true)
              setError('')
              try {
                const items = await request<Release[]>('/releases')
                setReleases(items)
                setSelected(items[0]?.version || '')
              } catch (e) {
                setError(e instanceof Error ? e.message : '检查更新失败')
              } finally {
                setRequesting(false)
              }
            }}
          >
            <RefreshCw size={14} />
            检查内核更新
          </button>
          <button
            className="button small"
            disabled={busy || !status?.previous}
            onClick={() =>
              setConfirm({
                action: 'rollback',
                target: status!.previous!,
                expected: status?.current?.id || '',
              })
            }
          >
            回退版本
          </button>
        </div>
      </div>
      {!!releases.length && (
        <div className="core-update-row">
          <label className="control-row">
            <span>目标版本</span>
            <select
              aria-label="内核目标版本"
              value={selected}
              disabled={busy}
              onChange={(e) => setSelected(e.target.value)}
            >
              {releases.map((item) => (
                <option key={item.version}>{item.version}</option>
              ))}
            </select>
          </label>
          <button
            className="button small"
            disabled={busy || !selected}
            onClick={() =>
              void run('prepare', { version: selected, expectedCurrent: status?.current?.id || '' })
            }
          >
            下载并检查
          </button>
        </div>
      )}
      {status?.prepared && (
        <div className="core-prepared">
          <div>
            <strong>已准备 {status.prepared.version}</strong>
            <p>Schema {status.prepared.schemaVersion} · 发布包校验及 mihomo -t 已通过</p>
            {status.prepared.schemaWarning && (
              <p className="core-warning">{status.prepared.schemaWarning}</p>
            )}
          </div>
          <button
            className="button small primary"
            disabled={busy}
            onClick={() =>
              setConfirm({
                action: 'activate',
                target: status.prepared!,
                expected: status.current?.id || '',
              })
            }
          >
            预览切换
          </button>
        </div>
      )}
      {status?.current?.schemaWarning && (
        <p className="resource-note core-warning">{status.current.schemaWarning}</p>
      )}
      {status?.operation?.status === 'running' && (
        <p className="resource-note" role="status">
          {status.operation.phase}…
        </p>
      )}
      {status?.operation?.status === 'succeeded' && (
        <p className="resource-note" role="status">
          {status.operation.kind}完成
        </p>
      )}
      {(error || status?.operation?.error) && (
        <p className="resource-note core-warning" role="alert">
          {error || status?.operation?.error}
        </p>
      )}
      {status?.enabled && (
        <p className="resource-note">
          保存草稿后可通过“应用到内核”更新运行配置。校验及运行检查通过后才提交，失败恢复原配置。
        </p>
      )}
      {confirm && (
        <Modal
          title={confirm.action === 'rollback' ? '确认回退内核' : '确认切换内核'}
          onClose={() => setConfirm(undefined)}
        >
          <div className="core-confirm modal-scroll">
            <p>
              内核：{status?.current?.version || '未安装'} → {confirm.target.version}
            </p>
            <p>
              Schema：{status?.current?.schemaVersion || '1.19.32'} → {confirm.target.schemaVersion}
            </p>
            {confirm.target.schemaWarning && (
              <p className="core-warning">{confirm.target.schemaWarning}</p>
            )}
            <p>切换会短暂中断托管内核的连接。健康检查通过后提交版本，失败时恢复原版本。</p>
          </div>
          <div className="modal-actions">
            <button className="button" onClick={() => setConfirm(undefined)}>
              取消
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void run(confirm.action, {
                  id: confirm.target.id,
                  expectedCurrent: confirm.expected,
                })
              }
            >
              确认{confirm.action === 'rollback' ? '回退' : '切换'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  )
}
