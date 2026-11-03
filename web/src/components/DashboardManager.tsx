import { useEffect, useState } from 'react'
import { ExternalLink, RefreshCw, RotateCcw } from 'lucide-react'
import { apiFetch } from '../lib/transport'
import { Modal } from './Modal'

type Status = {
  enabled: boolean
  reason?: string
  current: string
  previous?: string
  latest?: { version: string; sha256: string; published: string; size: number }
  autoCheck: boolean
  lastChecked?: string
  nextCheck?: string
  checkError?: string
  updateAvailable: boolean
  busy: boolean
  operation?: { kind: string; status: string; phase: string; error?: string }
}
type Confirmation = {
  action: 'update' | 'rollback'
  expected: string
  target: string
  digest?: string
}

async function request(path = '', body?: object, method = 'POST'): Promise<Status> {
  const response = await apiFetch(`/api/dashboard-manager${path}`, {
    method: body ? method : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '面板操作失败')
  return data
}
const date = (value?: string) =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未检查'

export function DashboardManager() {
  const [status, setStatus] = useState<Status>()
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [requesting, setRequesting] = useState(false)
  const [confirm, setConfirm] = useState<Confirmation>()
  useEffect(() => {
    let disposed = false,
      loading = false
    async function refresh() {
      if (loading) return
      loading = true
      try {
        const result = await request()
        if (!disposed) {
          setStatus(result)
          setLoadError('')
        }
      } catch (e) {
        if (!disposed) setLoadError(e instanceof Error ? e.message : '读取面板状态失败')
      } finally {
        loading = false
      }
    }
    void refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [])
  async function run(path: string, body: object, method = 'POST') {
    setRequesting(true)
    setError('')
    try {
      setStatus(await request(path, body, method))
      setConfirm(undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : '面板操作失败')
    } finally {
      setRequesting(false)
    }
  }
  const busy = requesting || status?.busy || !status?.enabled
  const operation = status?.operation
  const completed =
    operation?.status === 'success' && ['update', 'rollback'].includes(operation.kind)
  return (
    <section className="panel dashboard-manager" aria-labelledby="dashboard-update-heading">
      <div className="panel-heading">
        <div>
          <h2 id="dashboard-update-heading">Zashboard 面板</h2>
          <p>独立管理面板版本，更新不重启 Mihomo，也不修改代理配置。</p>
        </div>
        <span className={`badge ${status?.updateAvailable ? 'amber' : 'gray'}`}>
          {status?.busy
            ? operation?.phase
            : status?.checkError
              ? '检查失败'
              : status?.updateAvailable
                ? '发现新版本'
                : status?.lastChecked
                  ? '已是最新稳定版'
                  : '待检查'}
        </span>
      </div>
      {status?.enabled === false ? (
        <p className="resource-note">{status?.reason || 'Dashboard 更新目前仅接入本地环境。'}</p>
      ) : (
        <>
          <dl className="dashboard-versions">
            <div>
              <dt>当前版本</dt>
              <dd>{status?.current || '读取中…'}</dd>
            </div>
            <div>
              <dt>最新稳定版</dt>
              <dd>{status?.latest?.version || '尚未检查'}</dd>
            </div>
            <div>
              <dt>可回退版本</dt>
              <dd>{status?.previous || '暂无'}</dd>
            </div>
          </dl>
          <div className="dashboard-update-controls">
            <label className="dashboard-auto-check">
              <input
                type="checkbox"
                checked={status?.autoCheck ?? false}
                disabled={busy}
                onChange={(e) => void run('/settings', { autoCheck: e.target.checked }, 'PUT')}
              />
              <span>
                自动检查更新<small>管理服务运行时每 24 小时检查，只提示，不自动安装。</small>
              </span>
            </label>
            <div className="action-row">
              <button
                className="button small"
                disabled={busy}
                onClick={() => void run('/check', {})}
              >
                <RefreshCw size={14} />
                检查面板更新
              </button>
              <button
                className="button small primary"
                disabled={busy || !status?.updateAvailable}
                onClick={() =>
                  setConfirm({
                    action: 'update',
                    expected: status!.current,
                    target: status!.latest!.version,
                    digest: status!.latest!.sha256,
                  })
                }
              >
                更新面板
              </button>
              <button
                className="button small"
                disabled={busy || !status?.previous}
                onClick={() =>
                  setConfirm({
                    action: 'rollback',
                    expected: status!.current,
                    target: status!.previous!,
                  })
                }
              >
                <RotateCcw size={14} />
                回退面板
              </button>
            </div>
          </div>
          <p className="resource-note">
            上次检查：{date(status?.lastChecked)}
            {status?.autoCheck && status?.lastChecked
              ? ` · 下次检查：${date(status.nextCheck)}`
              : ''}
            <br />
            使用官方稳定版，无额外字体包。下载并校验成功后切换版本，失败保留当前面板。{' '}
            <a
              href="https://github.com/Zephyruso/zashboard/releases"
              target="_blank"
              rel="noreferrer"
            >
              查看发布记录 <ExternalLink size={11} />
            </a>
          </p>
          {status?.checkError && (
            <p className="resource-note core-warning" role="alert">
              检查失败：{status.checkError}。当前版本继续可用，自动检查开启时一小时后重试。
            </p>
          )}
          {operation?.status === 'failed' && operation.kind !== 'check' && (
            <p className="resource-note core-warning" role="alert">
              {operation.error}。当前版本未切换。
            </p>
          )}
          {completed && (
            <p className="resource-note dashboard-update-success" role="status">
              已{operation.kind === 'rollback' ? '回退' : '更新'}到 {status?.current}
              。请重新打开面板加载此版本。{' '}
              <a href="/api/dashboard/open" target="_blank" rel="noreferrer">
                打开 Zashboard
              </a>
            </p>
          )}
        </>
      )}
      {error && (
        <p className="resource-note core-warning" role="alert">
          {error}
        </p>
      )}
      {loadError && (
        <p className="resource-note core-warning" role="alert">
          {loadError}
        </p>
      )}
      {confirm && (
        <Modal
          title={confirm.action === 'update' ? '确认更新 Zashboard' : '确认回退 Zashboard'}
          onClose={() => !requesting && setConfirm(undefined)}
        >
          <div className="core-confirm">
            <p>
              面板版本：
              <strong>
                {confirm.expected} → {confirm.target}
              </strong>
            </p>
            <p>
              {confirm.action === 'update'
                ? '从官方 GitHub 下载并校验 SHA-256，成功后切换，保留当前版本供回退。'
                : '切换到本地保留的上一版，无需重新下载。'}
            </p>
            <p>此操作不修改 YAML，也不重启代理服务。已打开的 Zashboard 窗口需重新打开。</p>
            {error && (
              <p role="alert" className="core-warning">
                {error}
              </p>
            )}
          </div>
          <div className="modal-actions">
            <button className="button" disabled={requesting} onClick={() => setConfirm(undefined)}>
              取消
            </button>
            <button
              className="button primary"
              disabled={busy}
              onClick={() =>
                void run(`/${confirm.action}`, {
                  expected: confirm.expected,
                  target: confirm.target,
                  digest: confirm.digest,
                })
              }
            >
              {confirm.action === 'update' ? '确认更新' : '确认回退'}
            </button>
          </div>
        </Modal>
      )}
    </section>
  )
}
