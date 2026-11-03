import type { Config, Group, Provider } from './document'
import type { ProviderRuntimeStatus } from './api'

export const ORDER_KEY = 'x-manager-order'
export type MemberOrder = { version: 1; names: string[]; sourceFilter?: string }
export type GroupMember = { name: string; type: string; source: string }
export type MemberSource = {
  name: string
  manual: boolean
  nodes: GroupMember[]
  automaticNodes?: GroupMember[]
}
export type OrderPreview = {
  filter: string
  excludeFilter: string
  excludeType: string
  sources: MemberSource[]
}

export function readOrder(group: Group): MemberOrder | undefined {
  const value = group[ORDER_KEY] as MemberOrder | undefined
  return value?.version === 1 &&
    Array.isArray(value.names) &&
    value.names.every((n) => typeof n === 'string') &&
    (value.sourceFilter === undefined || typeof value.sourceFilter === 'string')
    ? value
    : undefined
}

export function moveEntry<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items]
  if (from < 0 || from >= next.length || to < 0 || to >= next.length) return next
  next.splice(to, 0, next.splice(from, 1)[0])
  return next
}

// regexp2 syntax, as used by Mihomo. Encode the native filter delimiter too.
function exactName(name: string) {
  return `\\A${name.replace(/[\\^$.*+?()[\]{}|#\s`]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\\z`
}

export function orderFilter(group: Group, order: MemberOrder): string {
  const original = order.sourceFilter
  const filters = original ? original.split('`') : []
  const manual = new Set(group.proxies || [])
  const expressions = order.names.flatMap((name) => {
    const exact = exactName(name)
    // CompatibleProvider (proxies) bypasses the inclusion filter in Mihomo.
    // For subscription members each ranking expression must retain that filter.
    return !filters.length || manual.has(name)
      ? [exact]
      : filters.map((filter) => `(?=(?s:.*?)(?:${filter}))${exact}`)
  })
  return [...expressions, ...(filters.length ? filters : ['[\\s\\S]*'])].join('`')
}

export function orderProblem(group: Group): string | undefined {
  if (!Object.hasOwn(group, ORDER_KEY)) return
  const order = readOrder(group)
  if (!order) return '排序记录格式无法识别，请在 YAML 中检查 x-manager-order。'
  if (group.filter !== orderFilter(group, order))
    return 'filter 已在 YAML 中修改。请先移除 x-manager-order，按当前筛选重新设置排序，避免覆盖你的修改。'
}

export function sourceGroup(group: Group): Group {
  const order = readOrder(group)
  const next = { ...group }
  if (order) {
    if (order.sourceFilter === undefined) delete next.filter
    else next.filter = order.sourceFilter
    delete next[ORDER_KEY]
  }
  return next
}

export function withOrder(group: Group, names: string[]): Group {
  const base = sourceGroup(group)
  const order: MemberOrder = {
    version: 1,
    names: [...new Set(names)],
    ...(typeof base.filter === 'string' ? { sourceFilter: base.filter } : {}),
  }
  const rank = new Map(order.names.map((name, i) => [name, i]))
  const next: Group = { ...base, [ORDER_KEY]: order }
  // A group containing only manual nodes has one CompatibleProvider: the core
  // deliberately skips filter sorting for it, so reorder its references as well.
  if (base.proxies)
    next.proxies = [...base.proxies].sort(
      (a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity),
    )
  next.filter = orderFilter(next, order)
  return next
}

export function renameOrderedMember(group: Group, old: string, name: string): Group {
  const order = readOrder(group)
  if (!order || !order.names.includes(old)) return group
  if (orderProblem(group))
    throw new Error(`代理组 ${group.name} 的排序与 filter 不一致，请先修复。`)
  const next = { ...group, proxies: group.proxies?.map((n) => (n === old ? name : n)) }
  return withOrder(
    next,
    order.names.map((n) => (n === old ? name : n)),
  )
}

const coreTypes: Record<string, string> = {
  ss: 'Shadowsocks',
  ssr: 'ShadowsocksR',
  vmess: 'Vmess',
  vless: 'Vless',
  trojan: 'Trojan',
  hysteria2: 'Hysteria2',
  hysteria: 'Hysteria',
  tuic: 'Tuic',
  wireguard: 'WireGuard',
  socks5: 'Socks5',
  http: 'Http',
  direct: 'Direct',
  reject: 'Reject',
  anytls: 'AnyTLS',
  select: 'Selector',
  'url-test': 'URLTest',
  fallback: 'Fallback',
  'load-balance': 'LoadBalance',
}

export function memberSources(
  config: Config,
  group: Group,
  live?: ProviderRuntimeStatus,
  applied?: Config,
) {
  const notices: string[] = []
  const nodes = [...(config.proxies || []), ...(config['proxy-groups'] || [])]
  const manualNames = [...new Set(group.proxies || [])]
  const automaticNames =
    group['include-all'] || group['include-all-proxies']
      ? (config.proxies || []).map((n) => n.name).sort()
      : []
  const describe = (name: string): GroupMember => {
    const node = nodes.find((n) => n.name === name)
    return {
      name,
      type: coreTypes[node?.type || name.toLowerCase()] || node?.type || name,
      source: config.proxies?.some((n) => n.name === name) ? '自建' : node ? '代理组' : '内置',
    }
  }
  const sources: MemberSource[] = []
  if (manualNames.length || automaticNames.length)
    sources.push({
      name: '手动成员',
      manual: true,
      nodes: manualNames.map(describe),
      automaticNodes: automaticNames.map(describe),
    })
  const providers = config['proxy-providers'] || {}
  const providerNames =
    group['include-all'] || group['include-all-providers']
      ? Object.keys(providers).sort()
      : group.use || []
  for (const name of providerNames) {
    const provider: Provider | undefined = providers[name]
    const runtime = live?.providers.find((p) => p.name === name)
    let members: GroupMember[] = []
    if (
      provider &&
      runtime?.state === 'loaded' &&
      runtime.members?.length &&
      runtime.nodes === runtime.members.length &&
      runtime.members.every((n) => typeof n.name === 'string' && n.name.length > 0) &&
      applied &&
      JSON.stringify(applied['proxy-providers']?.[name]) === JSON.stringify(provider)
    ) {
      members = runtime.members.map((n) => ({ ...n, source: name }))
    } else if (
      provider?.type === 'inline' &&
      Array.isArray(provider.payload) &&
      provider.payload.every((n) => n && typeof n.name === 'string' && n.name.length > 0) &&
      !provider.filter &&
      !provider['exclude-filter'] &&
      !provider['exclude-type'] &&
      !provider.override
    ) {
      members = provider.payload.map((n) => ({
        name: n.name,
        type: coreTypes[n.type] || n.type || '',
        source: name,
      }))
    } else {
      notices.push(`${name}：尚无与草稿一致的内核节点列表，已有排序记录会保留。`)
    }
    sources.push({ name, manual: false, nodes: members })
  }
  // Explicit and auto-included references to the same local node share identity;
  // names repeated across different sources cannot be ranked unambiguously.
  const names = sourceNames(sources)
  const duplicates = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))]
  return { sources, notices, duplicates, complete: notices.length === 0 && duplicates.length === 0 }
}

function sourceNames(sources: MemberSource[]): string[] {
  return sources.flatMap((s) => [
    ...new Set([...s.nodes, ...(s.automaticNodes || [])].map((n) => n.name)),
  ])
}

export function previewInput(group: Group, sources: MemberSource[]): OrderPreview {
  return {
    sources,
    filter: String(group.filter || ''),
    excludeFilter: String(group['exclude-filter'] || ''),
    excludeType: String(group['exclude-type'] || ''),
  }
}

export function orderedRows(names: string[], available: GroupMember[]) {
  const byName = new Map(available.map((n) => [n.name, n]))
  return [...new Set([...names, ...available.map((n) => n.name)])].map((name) => ({
    ...(byName.get(name) || { name, type: '', source: '保留的排序' }),
    missing: !byName.has(name),
  }))
}

/** Absence from a filtered preview does not prove absence from its source. */
export function inspectOrder(
  names: string[],
  sources: MemberSource[],
  members: GroupMember[],
  complete: boolean,
) {
  const source = new Set(sourceNames(sources))
  const rows = orderedRows(names, members)
  const inactive = rows.filter((n) => n.missing).map((n) => n.name)
  const absent = inactive.filter((name) => !source.has(name))
  return {
    active: rows.filter((n) => !n.missing),
    hidden: inactive.filter((name) => source.has(name)),
    stale: complete ? absent : [],
    unresolved: complete ? [] : absent,
    complete,
  }
}

/** Reorder visible members without dropping positions retained outside the preview. */
export function moveActiveOrder(
  names: string[],
  activeNames: string[],
  from: number,
  to: number,
): string[] {
  const active = [...new Set(activeNames)]
  const moved = moveEntry(active, from, to)
  const activeSet = new Set(active)
  let index = 0
  return [...new Set([...names, ...active])].map((name) =>
    activeSet.has(name) ? moved[index++] : name,
  )
}

export function cleanOrderNames(
  names: string[],
  sources: MemberSource[],
  complete: boolean,
): string[] {
  const available = sourceNames(sources)
  if (!complete || new Set(available).size !== available.length)
    throw new Error('成员来源尚未完整确认，暂不能清理排序记录。')
  const retained = new Set(available)
  return names.filter((name) => retained.has(name))
}

/** Cleanup changes only ranking metadata/filter, never sources or runtime selection. */
export function cleanOrder(group: Group, sources: MemberSource[], complete: boolean): Group {
  const issue = orderProblem(group)
  if (issue) throw new Error(issue)
  const order = readOrder(group)
  if (!order) throw new Error('此代理组没有自定义排序记录。')
  const names = cleanOrderNames(order.names, sources, complete)
  if (names.length === order.names.length) return group
  const next = { ...order, names }
  return { ...group, [ORDER_KEY]: next, filter: orderFilter(group, next) }
}
