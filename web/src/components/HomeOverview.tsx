import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ExternalLink, FileCode2, Play, RefreshCw, Square } from 'lucide-react'
import type { State } from '../lib/api'
import { analyze } from '../lib/document'
import { routerMode } from '../lib/transport'
import { formatBytes } from '../lib/metrics'
import { coreDisplay, homeChecks, type CoreAction } from '../lib/homeState'
import { ModeControl, modeNames as modes } from './WorkspacePrimitives'
import './home.css'

const clock = (at?: string) =>
  at ? new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—'
function duration(at?: string) {
  if (!at) return '—'
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(at).getTime()) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor((seconds % 3600) / 60)} 分钟`
}
export function HomeOverview({
  state,
  dirty,
  unapplied,
  busy,
  error,
  updatedAt,
  onPower,
  onRestart,
  onMode,
  pendingAction = null,
  controlError = '',
  onPersistMode,
  onSwitch,
  onEdit,
  onProfiles,
  onApply,
  dashboardURL,
  onRefresh,
  onHistory,
}: {
  state: State
  dirty: boolean
  unapplied: boolean
  busy: boolean
  error: string
  updatedAt: string
  onPower: () => void
  onRestart: () => void
  onMode: (mode: string) => void
  pendingAction?: CoreAction | null
  controlError?: string
  onPersistMode: () => void
  onSwitch: (id: string) => void
  onEdit: () => void
  onProfiles: () => void
  onApply: () => void
  dashboardURL: () => string
  onRefresh: () => void
  onHistory: () => void
}) {
  const [selected, setSelected] = useState(state.profileID || '')
  const [, tick] = useState(0)
  useEffect(() => {
    if (!state.simulation || !state.runtime.running) return
    const timer = window.setInterval(() => tick((v) => v + 1), 30000)
    return () => clearInterval(timer)
  }, [state.simulation, state.runtime.running])
  useEffect(() => {
    setSelected(state.profileID || '')
  }, [state.profileID])
  useEffect(() => {
    if (selected && !state.profiles?.some((p) => p.id === selected))
      setSelected(state.profileID || '')
  }, [state.profiles, selected, state.profileID])
  const applied = useMemo(() => analyze(state.applied).config || {}, [state.applied])
  const simulated = state.simulation && !!state.profiles
  const display = coreDisplay(state, error, pendingAction)
  const running = display.running
  const canControl = simulated || state.core?.controlAvailable
  const processRunning = running || state.core?.processState === 'running'
  const disabled = busy || !!error || !canControl || state.core?.processState === 'unknown'
  const metrics = !error && running && state.metrics?.available ? state.metrics : undefined
  const download = formatBytes(metrics?.downloadRate, '/s')
  const upload = formatBytes(metrics?.uploadRate, '/s')
  const memory = formatBytes(metrics?.memory)
  const defaultMode = String(applied.mode || 'rule')
  const mode = state.runtime.mode
  const groups = applied['proxy-groups'] || []
  // Show the final MATCH policy, rather than assuming every config has the same group.
  const match = [...(applied.rules || [])]
    .reverse()
    .find((rule) => rule.startsWith('MATCH,'))
    ?.split(',')[1]
  const group = groups.find((g) => g.name === match)
  let target =
    mode === 'direct'
      ? 'DIRECT'
      : mode === 'global'
        ? state.runtime.selected.GLOBAL || 'DIRECT'
        : group
          ? state.runtime.selected[group.name] || group.name
          : match || '按规则匹配'
  const route = [target]
  const visited = new Set<string>()
  while (groups.some((g) => g.name === target) && !visited.has(target)) {
    visited.add(target)
    const next = state.runtime.selected[target]
    if (!next || visited.has(next)) break
    target = next
    route.push(target)
  }
  const node = applied.proxies?.find((n) => n.name === target)
  const heading =
    mode === 'global' ? 'GLOBAL 出口' : mode === 'direct' ? '当前出口' : group?.name || '兜底策略'
  const events = state.events?.slice(0, 3) || []
  const operationError =
    controlError || (state.core?.operation.status === 'failed' ? state.core.operation.error : '')
  return (
    <div className="home-overview">
      <section className="home-panel home-service" aria-label="服务状态">
        <div className="home-service-top">
          <div>
            <h2 className="home-state" role="status" aria-live="polite">
              <span className={`home-dot ${display.tone}`} />
              {display.label}
            </h2>
            <p className="home-muted">
              {simulated
                ? '本地预览 · 操作仅改变模拟状态'
                : state.core?.version
                  ? `Mihomo ${state.core.version}`
                  : 'Mihomo · 版本暂不可用'}
              <span className="home-separator">·</span>
              {simulated && running
                ? `已运行 ${duration(state.runtime.startedAt)}`
                : '使用已应用配置'}
            </p>
          </div>
          <div className="action-row">
            <>
              <button
                className={`button ${!processRunning ? 'primary' : ''}`}
                disabled={disabled}
                onClick={onPower}
              >
                {processRunning ? <Square size={16} /> : <Play size={16} />}
                {pendingAction === 'stop'
                  ? '正在停止…'
                  : pendingAction === 'start'
                    ? '正在启动…'
                    : processRunning
                      ? '停止内核'
                      : '启动内核'}
              </button>
              <button className="button" disabled={disabled || !processRunning} onClick={onRestart}>
                <RefreshCw size={16} />
                {pendingAction === 'restart' ? '正在重启…' : '重启内核'}
              </button>
            </>
            {busy || !!error || !running ? (
              <button className="button" disabled>
                <ExternalLink size={15} />
                打开 Zashboard
              </button>
            ) : (
              <a className="button" href={dashboardURL()} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={15} />
                打开 Zashboard
              </a>
            )}
          </div>
        </div>
        {operationError && (
          <p className="home-control-error" role="alert">
            操作未完成：{operationError}。可重试或刷新状态。
          </p>
        )}
        <dl className="home-service-checks">
          {homeChecks(state, applied, error).map((check) => (
            <div key={check.label}>
              <dt>{check.label}</dt>
              <dd>
                <i className={`home-dot ${check.tone}`} />
                {check.value}
              </dd>
              <p>{check.detail}</p>
            </div>
          ))}
        </dl>
        <div className="home-service-footnote">
          <span>
            {simulated
              ? '这里只控制模拟内核，停止后管理页面仍可使用。'
              : canControl
                ? '停止内核会撤销流量接管并恢复直连，Web 管理页面保持运行。'
                : '当前管理服务尚未开放内核启停接口。'}
          </span>
          <span>总开关、开机启动和 Web 端口在 LuCI 设置。</span>
        </div>
      </section>
      <section className="home-metrics" aria-label="内核统计">
        {[
          { title: '内核下载', Icon: ArrowDown, ...download },
          { title: '内核上传', Icon: ArrowUp, ...upload },
          {
            title: '活动连接',
            Icon: undefined,
            value: metrics ? String(metrics.connections) : '—',
            unit: metrics ? '个' : '',
          },
          { title: '内存占用', Icon: undefined, ...memory },
        ].map(({ title, Icon, unit, value }) => (
          <div className="home-metric" key={title}>
            <span>
              {Icon && <Icon size={13} />}
              {title}
            </span>
            <strong>
              {value}
              <small>{unit}</small>
            </strong>
          </div>
        ))}
      </section>
      <div className="home-metrics-note">
        {simulated
          ? '本地未连接内核，暂无流量、连接数和内存数据。'
          : metrics
            ? `内核统计更新于 ${clock(metrics.sampledAt)}${metrics.downloadRate === null ? '，正在采样速率' : '，约每 1.5 秒刷新'}`
            : error ||
              (!running
                ? '内核未就绪，暂无实时统计。'
                : state.metrics?.error || '正在读取内核统计…')}
      </div>
      <section className="home-panel" aria-label="当前配置">
        <div className="home-section-heading">
          <h2>当前配置</h2>
          <button className="text-button" onClick={onProfiles}>
            管理配置 →
          </button>
        </div>
        <div className="home-config-picker">
          <FileCode2 size={18} />
          <select
            aria-label="选择配置"
            value={selected}
            disabled={disabled || !state.profiles?.length}
            onChange={(e) => setSelected(e.target.value)}
          >
            {state.profiles?.map((p) => (
              <option value={p.id} key={p.id}>
                {p.name}
                {p.id === state.profileID ? ' · 当前' : ''}
              </option>
            )) || <option>config.yaml</option>}
          </select>
          <button
            className="button"
            disabled={disabled || selected === state.profileID || !selected}
            onClick={() => onSwitch(selected)}
          >
            切换配置
          </button>
          <button className="button" onClick={onEdit}>
            编辑
          </button>
        </div>
        <div className="home-config-note">
          <span className={`home-badge ${dirty || unapplied ? 'pending' : ''}`}>
            {dirty ? '有未保存修改' : unapplied ? '已保存待应用' : '已应用'}
          </span>
          <span>
            {selected && selected !== state.profileID
              ? `当前使用 ${state.profileName || 'config.yaml'}，尚未切换`
              : dirty
                ? '编辑内容未保存，运行配置不受影响'
                : unapplied
                  ? '当前使用上次应用的版本'
                  : '草稿与已应用配置一致'}
          </span>
          {(dirty || unapplied) && (
            <button className="text-button" disabled={busy || !!error} onClick={onApply}>
              查看更改并应用
            </button>
          )}
        </div>
      </section>
      <div className="home-two-columns">
        <section className="home-panel" aria-label="运行模式">
          <div className="home-section-heading">
            <h2>运行模式</h2>
            <span className="home-muted">
              {simulated ? '仅影响模拟运行' : '临时生效，重启后按 YAML 恢复'}
            </span>
          </div>
          <ModeControl
            className="home-mode-control"
            label="切换运行模式"
            value={!error && running ? mode : ''}
            disabled={busy || !!error || (!simulated && !routerMode) || !running}
            onChange={onMode}
          />
          <p className="home-mode-note">
            {error
              ? '重新连接后读取实际状态。'
              : !running
                ? '启动时按已应用 YAML 初始化。'
                : mode === 'global'
                  ? '使用 GLOBAL 代理组；网络接管范围不变。'
                  : mode === 'direct'
                    ? '经过内核的流量直连，服务继续运行。'
                    : '按当前配置中的规则匹配目标策略。'}
          </p>
          <div className="home-mode-default">
            <span>配置默认：{modes[defaultMode] || defaultMode}</span>
            {mode !== defaultMode && running && (
              <>
                <span>重启后恢复默认</span>
                {simulated && (
                  <button className="text-button" disabled={disabled} onClick={onPersistMode}>
                    写入配置…
                  </button>
                )}
              </>
            )}
          </div>
        </section>
        <section className="home-panel" aria-label="出口策略">
          <div className="home-section-heading">
            <h2>{heading}</h2>
            <span className="home-badge neutral">{simulated ? '模拟选择' : '内核当前选择'}</span>
          </div>
          <div className="home-egress">
            <strong>
              {error ? '—' : pendingAction ? '正在更新状态…' : !running ? '内核未就绪' : target}
            </strong>
            {running && !error ? (
              <>
                <span>
                  {node?.type || (target === 'DIRECT' ? '直连' : group?.type || '规则目标')}
                  {simulated && ' · 未检测节点连通性'}
                </span>
                {route.length > 1 && <span>{route.join(' → ')}</span>}
              </>
            ) : (
              <span>内核就绪后读取当前出口。</span>
            )}
          </div>
          {busy || !!error || !running ? (
            <button className="text-button" disabled>
              在 Zashboard 中切换节点 <ExternalLink size={13} />
            </button>
          ) : (
            <a
              className="text-button"
              href={dashboardURL()}
              target="_blank"
              rel="noopener noreferrer"
            >
              在 Zashboard 中切换节点 <ExternalLink size={13} />
            </a>
          )}
        </section>
      </div>
      <section className="home-panel" aria-label="最近操作">
        <div className="home-section-heading">
          <h2>最近操作</h2>
          <div className="action-row">
            <button className="text-button" disabled={busy} onClick={onRefresh}>
              <RefreshCw size={13} />
              刷新状态
            </button>
            {busy || !!error || !running ? (
              <button className="text-button" disabled>
                去 Zashboard 查看日志 <ExternalLink size={13} />
              </button>
            ) : (
              <a
                className="text-button"
                href={dashboardURL()}
                target="_blank"
                rel="noopener noreferrer"
              >
                去 Zashboard 查看日志 <ExternalLink size={13} />
              </a>
            )}
          </div>
        </div>
        {events.length ? (
          <ul className="home-events">
            {events.map((e, i) => (
              <li key={`${e.at}-${i}`}>
                <time>{clock(e.at)}</time>
                <div>
                  <strong>{e.title}</strong>
                  <p>{e.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : state.core?.operation ? (
          <p className="home-empty-events" role="status">
            {state.core.operation.kind}：{state.core.operation.phase}
            {state.core.operation.error && ` · ${state.core.operation.error}`}
          </p>
        ) : (
          <p className="home-empty-events">
            本次会话暂无操作。
            <button className="text-button" onClick={onHistory}>
              查看配置修订记录 →
            </button>
          </p>
        )}
      </section>
      <footer className="home-footer">
        <span>{error ? '连接中断，保留最后一次状态' : `状态更新于 ${clock(updatedAt)}`}</span>
        <span>{simulated ? '本地预览 · 未连接路由器' : '状态与配置分开显示'}</span>
      </footer>
    </div>
  )
}
