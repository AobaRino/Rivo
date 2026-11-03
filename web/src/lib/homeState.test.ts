import { expect, it } from 'vitest'
import { coreDisplay, homeChecks } from './homeState'
import type { State } from './api'

const state: State = {
  simulation: false,
  draft: '',
  applied: '',
  revision: '',
  savedAt: '',
  appliedAt: '',
  history: [],
  runtime: { mode: 'rule', logLevel: 'info', running: false, selected: {} },
  core: {
    currentID: 'internal-id',
    busy: false,
    running: false,
    operation: { kind: '', status: '', phase: '' },
  },
}
it('never treats an unreachable API as proof that the core has stopped', () => {
  expect(coreDisplay(state).label).toBe('状态未知')
  expect(
    coreDisplay({ ...state, core: { ...state.core!, processState: 'running', apiReady: false } })
      .label,
  ).toBe('内核接口不可用')
  expect(coreDisplay({ ...state, core: { ...state.core!, processState: 'stopped' } }).label).toBe(
    '内核已停止',
  )
})
it('connection errors override stale success and actions have explicit pending states', () => {
  const running = { ...state, core: { ...state.core!, running: true } }
  expect(coreDisplay(running, 'offline')).toMatchObject({ label: '状态未知', running: false })
  expect(coreDisplay(running, '', 'restart')).toMatchObject({
    label: '正在重启内核…',
    tone: 'pending',
  })
})
it('describes configuration and markers without claiming network or DNS health', () => {
  const checks = homeChecks(
    { ...state, networkEnabled: true },
    { dns: { enable: true, listen: '127.0.0.1:1053' } },
  )
  expect(checks[2].value).toBe('已记录启用')
  expect(checks[2].detail).toContain('非连通性检测')
  expect(checks[3].detail).toContain('尚未实时探测')
  expect(homeChecks({ ...state, networkEnabled: true }, {}, 'offline')[2].value).toBe('未知')
})
