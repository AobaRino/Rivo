import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { ProviderRuntimeStatus } from '../lib/api'

export function ProviderStatus({ appliedRevision }: { appliedRevision?: string }) {
  const [status, setStatus] = useState<ProviderRuntimeStatus>()
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false,
      loading = false
    const refresh = async () => {
      if (loading) return
      loading = true
      try {
        const next = await api.providers()
        if (!disposed) {
          setStatus(next)
          setError('')
        }
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : '无法读取订阅状态')
      } finally {
        loading = false
      }
    }
    void refresh()
    const timer = window.setInterval(refresh, 5000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [appliedRevision])
  const rows = status && status.appliedRevision === appliedRevision ? status.providers : undefined
  return (
    <section className="panel" aria-label="已应用订阅状态">
      <div className="panel-heading">
        <div>
          <h2>已应用订阅状态</h2>
          <p>来自正在运行的内核。节点已加载不代表连接检查通过。</p>
        </div>
      </div>
      <div className="resource-note" role="status">
        {error ? (
          <p>{error}</p>
        ) : !rows ? (
          <p>正在读取订阅状态…</p>
        ) : rows.length === 0 ? (
          <p>已应用配置没有订阅。</p>
        ) : (
          rows.map((row) => (
            <p key={row.name}>
              <strong>{row.name}</strong> ·{' '}
              {row.state === 'loaded'
                ? `已加载 ${row.nodes} 个节点`
                : row.state === 'empty'
                  ? '尚未加载节点，请检查来源、下载代理或过滤设置'
                  : '内核尚未报告此订阅'}
              {row.updatedAt && <> · 更新于 {new Date(row.updatedAt).toLocaleString('zh-CN')}</>}
            </p>
          ))
        )}
      </div>
    </section>
  )
}
