import { isMap, parseDocument } from 'yaml'

export type ChangeKind = 'added' | 'modified' | 'removed'
export type ConfigChange = { kind: ChangeKind; title: string; details: string[] }
export type ChangeSummary = { changes: ConfigChange[]; note?: string }
type RecordValue = Record<string, unknown>

const labels: Record<string, string> = {
  mode: '启动模式',
  'mixed-port': '混合端口',
  port: '端口',
  'socks-port': 'SOCKS 端口',
  'redir-port': '重定向端口',
  'tproxy-port': '透明代理端口',
  'allow-lan': '允许局域网连接',
  'bind-address': '监听地址',
  'log-level': '日志级别',
  ipv6: 'IPv6',
  dns: 'DNS',
  tun: 'TUN',
  profile: '配置持久化',
  sniffer: '流量嗅探',
  hosts: '静态域名映射',
  'external-controller': '控制接口',
  'external-ui': '控制面板',
  secret: '控制接口密钥',
  enable: '启用状态',
  listen: '监听地址',
  'enhanced-mode': '解析模式',
  nameserver: '上游 DNS',
  'default-nameserver': '默认 DNS',
  'proxy-server-nameserver': '节点域名 DNS',
  'direct-nameserver': '直连 DNS',
  fallback: '备用 DNS',
  'fake-ip-range': 'Fake-IP 地址段',
  'fake-ip-filter': 'Fake-IP 排除列表',
  'nameserver-policy': '域名解析策略',
  'respect-rules': '遵循分流规则',
  name: '名称',
  type: '类型',
  server: '服务器',
  password: '密码',
  uuid: 'UUID',
  cipher: '加密方式',
  tls: 'TLS',
  udp: 'UDP 转发',
  network: '传输协议',
  servername: '服务器名称',
  'client-fingerprint': '客户端指纹',
  'skip-cert-verify': '跳过证书验证',
  'reality-opts': 'Reality 参数',
  'public-key': '公钥',
  'private-key': '私钥',
  'short-id': 'Short ID',
  proxies: '节点与代理组',
  use: '订阅来源',
  url: '链接',
  interval: '更新间隔',
  path: '文件路径',
  filter: '筛选条件',
  'exclude-filter': '排除条件',
  'health-check': '健康检查',
  header: '请求头',
  override: '覆写设置',
  'store-selected': '保存节点选择',
  'store-fake-ip': '保存 Fake-IP',
  rules: '分流规则',
  'sub-rules': '子规则',
  'rule-providers': '规则集',
  behavior: '规则行为',
  format: '数据格式',
  payload: '内联内容',
  'proxy-providers': '订阅',
  'proxy-groups': '代理组',
  'geodata-mode': 'GEOIP 数据格式',
  'geodata-loader': 'DAT 加载方式',
  'geo-auto-update': 'GEO 自动更新',
  'geo-update-interval': 'GEO 更新间隔',
  'geox-url': 'GEO 来源',
  geosite: 'GeoSite',
  geoip: 'GeoIP DAT',
  mmdb: 'Country MMDB',
  asn: 'ASN MMDB',
}
const enums: Record<string, Record<string, string>> = {
  mode: { rule: '规则', global: '全局', direct: '直连' },
  type: {
    http: 'HTTP',
    file: '本地文件',
    inline: '内联内容',
    select: '手动选择',
    'url-test': '自动测速',
    fallback: '故障转移',
    'load-balance': '负载均衡',
  },
  'log-level': { debug: '调试', info: '信息', warning: '警告', error: '错误', silent: '静默' },
  'geodata-loader': { memconservative: '节省内存', standard: '标准加载' },
  behavior: { domain: '域名', ipcidr: 'IP 网段', classical: '经典规则' },
  format: { yaml: 'YAML', text: 'TEXT', mrs: 'MRS' },
}
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const owns = (value: RecordValue, key: string) => Object.hasOwn(value, key)
const label = (path: string[]) =>
  path.map((key) => (Object.hasOwn(labels, key) ? labels[key] : key)).join(' / ')
const clip = (value: string) => (value.length > 100 ? value.slice(0, 100) + '…' : value)

// Validate the resolved tree before diffing: YAML aliases can produce cycles.
function readConfig(text: string): RecordValue {
  const doc = parseDocument(text, { uniqueKeys: true, merge: true })
  if (doc.errors.length || doc.warnings.length || !isMap(doc.contents)) throw new Error('yaml')
  const config = doc.toJS({ maxAliasCount: 100 }) as RecordValue
  const active = new WeakSet<object>()
  let remaining = 100000
  const visit = (value: unknown, depth: number) => {
    if (--remaining < 0 || depth > 64) throw new Error('complexity')
    if (value === null || typeof value !== 'object') return
    if (active.has(value)) throw new Error('cycle')
    active.add(value)
    for (const child of Object.values(value)) visit(child, depth + 1)
    active.delete(value)
  }
  visit(config, 0)
  return config
}
function fingerprint(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(fingerprint))
  if (record(value))
    return JSON.stringify(
      Object.keys(value)
        .sort()
        .map((key) => [key, fingerprint(value[key])]),
    )
  return `${typeof value}:${String(value)}`
}
const equal = (a: unknown, b: unknown) => fingerprint(a) === fingerprint(b)
function confidential(path: string[]) {
  return (
    path.some((key) =>
      /password|secret|token|uuid|private-key|public-key|short-id|authorization|^headers?$|^auth$/i.test(
        key,
      ),
    ) ||
    (path[0] === 'proxy-providers' && path.includes('url'))
  )
}
function valueText(value: unknown, key = ''): string {
  if (value === undefined) return '未设置'
  if (value === null) return '空值'
  if (key === 'geodata-mode' && typeof value === 'boolean') return value ? 'DAT' : 'MMDB'
  if (key === 'geo-update-interval' && typeof value === 'number') return `${value} 小时`
  if (typeof value === 'boolean') return value ? '开启' : '关闭'
  if (Array.isArray(value)) return `${value.length} 项`
  if (record(value)) return `${Object.keys(value).length} 个字段`
  if (typeof value === 'string') {
    if (Object.hasOwn(enums, key) && Object.hasOwn(enums[key], value)) return enums[key][value]
    if (/^[a-z][\w+.-]*:\/\//i.test(value)) {
      // Do not duplicate credentials or subscription tokens into the summary.
      try {
        return new URL(value).origin + '/…'
      } catch {
        return '地址'
      }
    }
    return value === '' ? '空字符串' : clip(value)
  }
  return String(value)
}
function listItems(values: unknown[]) {
  const shown = values
    .slice(0, 5)
    .map((value) => `「${valueText(value)}」`)
    .join('、')
  return values.length > 5 ? `${shown}等 ${values.length} 项` : shown
}
function unmatched(before: unknown[], after: unknown[]) {
  const available = new Map<string, number[]>()
  before.forEach((item, index) => {
    const key = fingerprint(item)
    available.set(key, [...(available.get(key) || []), index])
  })
  const matched = new Map<number, number>()
  after.forEach((item, index) => {
    const candidates = available.get(fingerprint(item))
    if (candidates?.length) matched.set(index, candidates.shift()!)
  })
  const used = new Set(matched.values())
  return {
    removed: before
      .map((value, index) => ({ value, index }))
      .filter((item) => !used.has(item.index)),
    added: after
      .map((value, index) => ({ value, index }))
      .filter((item) => !matched.has(item.index)),
    matched,
  }
}
function listDetail(before: unknown[], after: unknown[]) {
  const { removed, added, matched } = unmatched(before, after)
  const pieces: string[] = []
  if (added.length) pieces.push(`新增${listItems(added.map((item) => item.value))}`)
  if (removed.length) pieces.push(`移除${listItems(removed.map((item) => item.value))}`)
  const order = [...matched.values()]
  if (order.some((index, i) => i > 0 && index < order[i - 1])) pieces.push('调整顺序')
  return pieces.join('；') || '列表已修改'
}
function detail(before: unknown, after: unknown, path: string[]) {
  if (confidential(path))
    return before === undefined ? '已设置' : after === undefined ? '已移除' : '已修改'
  if (Array.isArray(before) && Array.isArray(after)) return listDetail(before, after)
  const key = path.at(-1)
  if (path[0] === 'rule-providers' && key === 'interval') {
    const seconds = (value: unknown) => (value === undefined ? '未指定' : `${value} 秒`)
    return before === undefined ? seconds(after) : `${seconds(before)} → ${seconds(after)}`
  }
  if (path[0] === 'rule-providers' && key === 'url') {
    if (before === undefined) return `已设置：${valueText(after)}`
    if (after === undefined) return '已移除'
    return `来源地址已修改（${valueText(after)}）；完整地址见 YAML 差异`
  }
  if (
    path[0] === 'geox-url' &&
    path.length === 2 &&
    ['geosite', 'geoip', 'mmdb', 'asn'].includes(key!)
  ) {
    if (after === undefined) return '恢复内核默认来源'
    if (before === undefined) return `自定义来源：${valueText(after)}`
    if (valueText(before) === valueText(after))
      return `来源地址已修改（${valueText(after)}）；完整地址见 YAML 差异`
    return `来源地址已修改：${valueText(before)} → ${valueText(after)}；完整地址见 YAML 差异`
  }
  if (
    path.length === 1 &&
    after === undefined &&
    ['geodata-mode', 'geodata-loader', 'geo-auto-update', 'geo-update-interval'].includes(key!)
  )
    return `原值：${valueText(before, key)}；恢复内核默认值`
  if (before === undefined) return valueText(after, key)
  if (after === undefined) return `原值：${valueText(before, key)}`
  const scalarTypes: Record<string, string> = { string: '文本', number: '数值', boolean: '布尔值' }
  if (
    typeof before !== typeof after &&
    owns(scalarTypes, typeof before) &&
    owns(scalarTypes, typeof after)
  )
    return `${valueText(before, key)}（${scalarTypes[typeof before]}） → ${valueText(after, key)}（${scalarTypes[typeof after]}）`
  return `${valueText(before, key)} → ${valueText(after, key)}`
}
function fields(
  before: RecordValue,
  after: RecordValue,
  emit: (kind: ChangeKind, path: string[], a: unknown, b: unknown) => void,
  path: string[] = [],
) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const next = [...path, key]
    if (!owns(before, key)) emit('added', next, undefined, after[key])
    else if (!owns(after, key)) emit('removed', next, before[key], undefined)
    else if (!equal(before[key], after[key])) {
      if (record(before[key]) && record(after[key]) && !confidential(next))
        fields(before[key], after[key], emit, next)
      else emit('modified', next, before[key], after[key])
    }
  }
}
function namedList(value: unknown): Map<string, RecordValue> | null {
  if (value === undefined) return new Map()
  if (!Array.isArray(value)) return null
  const result = new Map<string, RecordValue>()
  for (const item of value) {
    if (!record(item) || typeof item.name !== 'string' || !item.name || result.has(item.name))
      return null
    result.set(item.name, item)
  }
  return result
}
function namedMap(value: unknown): Map<string, RecordValue> | null {
  if (value === undefined) return new Map()
  if (!record(value) || Object.values(value).some((item) => !record(item))) return null
  return new Map(Object.entries(value) as [string, RecordValue][])
}
function entities(
  before: Map<string, RecordValue>,
  after: Map<string, RecordValue>,
  section: string,
  title: string,
  ordered: boolean,
  changes: ConfigChange[],
) {
  const matches = new Map<string, string>()
  for (const name of after.keys()) if (before.has(name)) matches.set(name, name)
  // Only infer a rename when the other fields uniquely identify both objects.
  const signature = (value: RecordValue) =>
    fingerprint(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'name')))
  const oldSignatures = new Map<string, string[]>()
  const newSignatures = new Map<string, string[]>()
  for (const [name, item] of before)
    if (!after.has(name)) {
      const key = signature(item)
      oldSignatures.set(key, [...(oldSignatures.get(key) || []), name])
    }
  for (const [name, item] of after)
    if (!before.has(name)) {
      const key = signature(item)
      newSignatures.set(key, [...(newSignatures.get(key) || []), name])
    }
  for (const [key, names] of newSignatures) {
    const old = oldSignatures.get(key)
    if (names.length === 1 && old?.length === 1) matches.set(names[0], old[0])
  }
  const matchedOld = new Set(matches.values())
  for (const name of before.keys())
    if (!matchedOld.has(name))
      changes.push({ kind: 'removed', title: `${title}「${name}」`, details: [] })
  for (const [name, item] of after) {
    const oldName = matches.get(name)
    if (oldName === undefined) {
      changes.push({
        kind: 'added',
        title: `${title}「${name}」`,
        details:
          section === 'rule-providers'
            ? ['type', 'behavior', 'format', 'url', 'path', 'interval', 'payload']
                .filter((key) => owns(item, key))
                .map((key) => `${labels[key]}：${detail(undefined, item[key], [section, key])}`)
            : [],
      })
      continue
    }
    const previous = before.get(oldName)!
    const details: string[] = []
    fields(previous, item, (kind, path, a, b) => {
      const action = kind === 'added' ? '新增' : kind === 'removed' ? '移除' : ''
      details.push(`${action}${label(path)}：${detail(a, b, [section, ...path])}`)
    })
    if (oldName !== name && !ordered) details.unshift(`名称：${oldName} → ${name}`)
    if (details.length)
      changes.push({
        kind: 'modified',
        title: oldName === name ? `${title}「${name}」` : `${title}「${oldName}」→「${name}」`,
        details,
      })
  }
  if (ordered) {
    const oldOrder = [...before.keys()].filter((name) => matchedOld.has(name))
    const newOrder = [...after.keys()]
      .filter((name) => matches.has(name))
      .map((name) => matches.get(name)!)
    if (!equal(oldOrder, newOrder))
      changes.push({
        kind: 'modified',
        title: `${title}排列顺序`,
        details: ['已有项目的排列顺序已调整。'],
      })
  }
}
function rules(before: string[], after: string[], changes: ConfigChange[]) {
  const { removed, added, matched } = unmatched(before, after)
  // Match a rule by its condition when only the target changes.
  const condition = (value: string) => {
    const parts = value.split(',')
    const noResolve = parts.at(-1)?.trim() === 'no-resolve' ? parts.pop() : ''
    if (parts.length < 2) return value
    parts.pop()
    return JSON.stringify([parts, noResolve])
  }
  const candidates = new Map<string, typeof removed>()
  for (const item of removed) {
    const key = condition(item.value as string)
    candidates.set(key, [...(candidates.get(key) || []), item])
  }
  const reused = new Set<number>()
  for (const item of added) {
    const previous = candidates.get(condition(item.value as string))?.shift()
    if (previous) {
      reused.add(previous.index)
      matched.set(item.index, previous.index)
      changes.push({
        kind: 'modified',
        title: `分流规则第 ${item.index + 1} 条`,
        details: [`${valueText(previous.value)} → ${valueText(item.value)}`],
      })
    } else
      changes.push({
        kind: 'added',
        title: `分流规则第 ${item.index + 1} 条`,
        details: [valueText(item.value)],
      })
  }
  for (const item of removed)
    if (!reused.has(item.index))
      changes.push({
        kind: 'removed',
        title: `原分流规则第 ${item.index + 1} 条`,
        details: [valueText(item.value)],
      })
  const order = [...matched.entries()].sort((a, b) => a[0] - b[0]).map(([, index]) => index)
  if (order.some((index, i) => i > 0 && index < order[i - 1]))
    changes.push({
      kind: 'modified',
      title: '分流规则顺序',
      details: ['已有规则的匹配顺序已调整，请核对下方 YAML。'],
    })
}

export function summarizeChanges(beforeText: string, afterText: string): ChangeSummary {
  if (beforeText === afterText) return { changes: [], note: '没有更改。' }
  let before: RecordValue, after: RecordValue
  try {
    before = readConfig(beforeText)
  } catch {
    return {
      changes: [],
      note: '上次保存的草稿无法解析为可比较的配置，无法生成完整摘要。请查看下方 YAML 差异。',
    }
  }
  try {
    after = readConfig(afterText)
  } catch {
    return {
      changes: [],
      note: '当前草稿无法解析为可比较的配置，无法生成完整摘要。请查看下方 YAML 差异。',
    }
  }
  const changes: ConfigChange[] = []
  const handled = new Set<string>()
  const oldGeo = before['geox-url']
  const newGeo = after['geox-url']
  if (
    (oldGeo === undefined || record(oldGeo)) &&
    (newGeo === undefined || record(newGeo)) &&
    (Object.keys(oldGeo || {}).length || Object.keys(newGeo || {}).length)
  ) {
    fields(
      oldGeo || {},
      newGeo || {},
      (kind, path, a, b) =>
        changes.push({ kind, title: label(path), details: [detail(a, b, path)] }),
      ['geox-url'],
    )
    handled.add('geox-url')
  }
  for (const [section, title, ordered] of [
    ['proxies', '自建节点', true],
    ['proxy-groups', '代理组', true],
    ['proxy-providers', '订阅', false],
    ['rule-providers', '规则集', false],
  ] as const) {
    if (!owns(before, section) && !owns(after, section)) continue
    // Keep absent vs. explicitly empty sections visible in the summary.
    if (!owns(before, section) && equal(after[section], ordered ? [] : {})) continue
    if (!owns(after, section) && equal(before[section], ordered ? [] : {})) continue
    const a = ordered ? namedList(before[section]) : namedMap(before[section])
    const b = ordered ? namedList(after[section]) : namedMap(after[section])
    if (a && b) {
      entities(a, b, section, title, ordered, changes)
      handled.add(section)
    }
  }
  const oldRules = owns(before, 'rules') ? before.rules : []
  const newRules = owns(after, 'rules') ? after.rules : []
  if (
    Array.isArray(oldRules) &&
    Array.isArray(newRules) &&
    (oldRules.length > 0 ||
      newRules.length > 0 ||
      owns(before, 'rules') === owns(after, 'rules')) &&
    [...oldRules, ...newRules].every((rule) => typeof rule === 'string')
  ) {
    rules(oldRules, newRules, changes)
    handled.add('rules')
  }
  const rest = (value: RecordValue) =>
    Object.fromEntries(Object.entries(value).filter(([key]) => !handled.has(key)))
  fields(rest(before), rest(after), (kind, path, a, b) =>
    changes.push({ kind, title: label(path), details: [detail(a, b, path)] }),
  )
  return {
    changes,
    note: changes.length ? undefined : '配置值未改变，仅调整了注释、格式或字段顺序。',
  }
}
