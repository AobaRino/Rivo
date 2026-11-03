import type { State } from './api'
import type { Config } from './document'

export type CoreAction = 'start' | 'stop' | 'restart'
export const coreActionLabels: Record<CoreAction, string> = {
  start: '正在启动内核…',
  stop: '正在停止内核…',
  restart: '正在重启内核…',
}

export function coreDisplay(state: State, error = '', action: CoreAction | null = null) {
  if (error) return { label: '状态未知', tone: 'warning', running: false }
  if (action) return { label: coreActionLabels[action], tone: 'pending', running: false }
  if (state.core?.busy)
    return { label: state.core.operation.phase || '内核处理中…', tone: 'pending', running: false }
  if (state.simulation)
    return {
      label: state.runtime.running ? '内核运行中' : '内核已停止',
      tone: state.runtime.running ? 'ok' : 'off',
      running: state.runtime.running,
    }
  if (state.core?.processState === 'unknown')
    return { label: '状态未知', tone: 'warning', running: false }
  if (state.core?.processState === 'running' && state.core.apiReady === false)
    return { label: '内核接口不可用', tone: 'warning', running: false }
  if (state.core?.running) return { label: '内核运行中', tone: 'ok', running: true }
  // An unreachable API alone does not prove that the process has stopped.
  if (state.core?.processState === 'stopped')
    return { label: '内核已停止', tone: 'off', running: false }
  return { label: '状态未知', tone: 'warning', running: false }
}

export function homeChecks(state: State, applied: Config, error = '') {
  const simulated = state.simulation
  const display = coreDisplay(state, error)
  return [
    {
      label: '管理服务',
      value: error ? '连接异常' : '已连接',
      detail: error ? '显示最后一次配置' : simulated ? '本地开发服务' : 'Web 管理服务正常',
      tone: error ? 'warning' : 'ok',
    },
    {
      label: '内核接口',
      value: simulated ? '模拟状态' : error ? '未知' : display.running ? '已连接' : '未连接',
      detail: simulated ? '未启动真实代理进程' : '与进程状态分别判断',
      tone: simulated ? 'off' : display.running ? 'ok' : 'warning',
    },
    {
      label: '流量接管',
      value: simulated
        ? '未接管'
        : error
          ? '未知'
          : state.networkEnabled === true
            ? '已记录启用'
            : state.networkEnabled === false
              ? '未记录启用'
              : '未知',
      detail: simulated ? '电脑网络保持原状' : '服务记录，非连通性检测',
      tone: 'off',
    },
    {
      label: 'DNS 配置',
      value: applied.dns?.enable ? '已配置' : '未启用',
      detail: applied.dns?.enable
        ? `${String(applied.dns.listen || '内核默认地址')} · 尚未实时探测`
        : '已应用 YAML 中未启用 DNS',
      tone: 'off',
    },
  ]
}
