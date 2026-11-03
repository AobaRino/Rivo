import { createElement, type ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { HomeOverview } from './HomeOverview'

const noop = () => {}
const props: ComponentProps<typeof HomeOverview> = {
  state: {
    simulation: false,
    draft: '',
    revision: 'saved',
    appliedAt: '',
    savedAt: '',
    history: [],
    applied:
      'mode: rule\nproxy-groups:\n  - name: 出口\n    type: select\n    use: [订阅]\nrules: ["MATCH,出口"]\n',
    runtime: {
      running: true,
      mode: 'global',
      logLevel: 'info',
      selected: { GLOBAL: '出口', 出口: '订阅节点' },
    },
    core: {
      currentID: 'router',
      busy: false,
      running: true,
      operation: { kind: '应用配置', phase: '已应用', status: 'success' },
    },
    metrics: {
      available: true,
      downloadRate: 1536,
      uploadRate: 0,
      connections: 42,
      memory: 104857600,
    },
  },
  dirty: false,
  unapplied: false,
  busy: false,
  error: '',
  updatedAt: '',
  onPower: noop,
  onRestart: noop,
  onMode: noop,
  onPersistMode: noop,
  onSwitch: noop,
  onEdit: noop,
  onProfiles: noop,
  onApply: noop,
  onRefresh: noop,
  onHistory: noop,
  dashboardURL: () => '/api/dashboard/open',
}

it('renders real core statistics, selected mode and provider-only group selection', () => {
  const html = renderToStaticMarkup(createElement(HomeOverview, props))
  expect(html).toContain('1.5<small>KiB/s')
  expect(html).toContain('0<small>B/s')
  expect(html).toContain('42<small>个')
  expect(html).toContain('100.0<small>MiB')
  expect(html).toContain('<strong>订阅节点</strong>')
  expect(html).toMatch(/<button\b(?=[^>]*aria-pressed="true")(?=[^>]*aria-label="全局")[^>]*>/)
  expect(html).toContain('应用配置：已应用')
  expect(html).not.toContain('尚未切换')
  expect(html).not.toContain('待接入')
})

it('does not display old metrics as live when the connection is lost', () => {
  const html = renderToStaticMarkup(createElement(HomeOverview, { ...props, error: '连接中断' }))
  expect(html).toContain('状态未知')
  expect(html).not.toContain('100.0<small>MiB')
  expect(html).not.toContain('<strong>订阅节点</strong>')
  expect(html).not.toContain('出口 → 订阅节点')
})

it('keeps core controls in the local preview and removes the boot-policy checkbox', () => {
  const html = renderToStaticMarkup(
    createElement(HomeOverview, {
      ...props,
      state: { ...props.state, simulation: true, core: undefined, profiles: [] },
    }),
  )
  expect(html).toContain('停止内核')
  expect(html).toContain('重启内核')
  expect(html).toContain('操作仅改变模拟状态')
  expect(html).toContain('总开关、开机启动和 Web 端口在 LuCI 设置')
  expect(html).not.toContain('type="checkbox"')
  expect(html).not.toContain('router-procd')
})

it('shows start and disables mode controls after stopping the preview core', () => {
  const html = renderToStaticMarkup(
    createElement(HomeOverview, {
      ...props,
      state: {
        ...props.state,
        simulation: true,
        core: undefined,
        profiles: [],
        runtime: { ...props.state.runtime, running: false },
      },
    }),
  )
  expect(html).toContain('内核已停止')
  expect(html).toContain('启动内核')
  expect(html).toMatch(/<button\b(?=[^>]*disabled="")(?=[^>]*aria-label="规则")[^>]*>/)
  expect(html).not.toContain('100.0<small>MiB')
})

it('enables real core controls only when the backend advertises support', () => {
  const render = (available: boolean, busy = false) =>
    renderToStaticMarkup(
      createElement(HomeOverview, {
        ...props,
        busy,
        state: {
          ...props.state,
          core: { ...props.state.core!, controlAvailable: available, processState: 'running' },
        },
      }),
    )
  expect(render(true)).toMatch(/<button class="button "[^>]*><svg[^]*?<\/svg>停止内核<\/button>/)
  expect(render(false)).toMatch(
    /<button class="button " disabled=""[^>]*><svg[^]*?<\/svg>停止内核<\/button>/,
  )
  expect(render(true, true)).toMatch(/<button class="button " disabled=""/)
  expect(render(true)).not.toContain('尚未开放内核启停接口')
  expect(render(true)).not.toContain('type="checkbox"')
})
