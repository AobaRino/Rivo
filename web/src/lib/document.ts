import { Document, isAlias, isMap, isNode, isScalar, isSeq, parseDocument, Scalar } from 'yaml'
import Ajv from 'ajv'
import { ruleProviderErrors, ruleProviderReferences, validateRuleProviders } from './ruleProviders'
import type { RuleProvider } from './ruleProviders'
import { ruleParts, ruleRows } from './rules'
import { ORDER_KEY, renameOrderedMember } from './groupOrder'

export type Path = (string | number)[]
export type ProxyNode = {
  name: string
  type: string
  server?: string
  port?: number | string
  [key: string]: unknown
}
export type Group = {
  name: string
  type: string
  proxies?: string[]
  use?: string[]
  [key: string]: unknown
}
export type Provider = {
  type: 'http' | 'file' | 'inline'
  url?: string
  interval?: number
  [key: string]: unknown
}
export type GeoSettings = {
  'geodata-mode'?: boolean
  'geodata-loader'?: 'memconservative' | 'standard'
  'geo-auto-update'?: boolean
  'geo-update-interval'?: number
}
export type GeoSource = 'geosite' | 'geoip' | 'mmdb' | 'asn'
export type Config = {
  mode?: string
  'mixed-port'?: number
  'log-level'?: string
  'allow-lan'?: boolean
  ipv6?: boolean
  proxies?: ProxyNode[]
  'proxy-groups'?: Group[]
  'proxy-providers'?: Record<string, Provider>
  'rule-providers'?: Record<string, RuleProvider>
  rules?: string[]
  'sub-rules'?: Record<string, string[]>
  dns?: { enable?: boolean; listen?: string; 'enhanced-mode'?: string; nameserver?: string[] }
  'geox-url'?: Partial<Record<GeoSource, string>>
  [key: string]: unknown
} & GeoSettings
export type Analysis = { config: Config | null; errors: string[]; warnings: string[] }

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  useDefaults: false,
  coerceTypes: false,
  removeAdditional: false,
})
const check = ajv.compile({
  type: 'object',
  properties: {
    mode: { enum: ['rule', 'global', 'direct'] },
    'mixed-port': { type: 'integer', minimum: 0, maximum: 65535 },
    'allow-lan': { type: 'boolean' },
    ipv6: { type: 'boolean' },
    'geodata-mode': { type: 'boolean' },
    'geodata-loader': { enum: ['memconservative', 'standard'] },
    'geo-auto-update': { type: 'boolean' },
    'geo-update-interval': { type: 'integer', minimum: 1 },
    'geox-url': {
      type: 'object',
      properties: Object.fromEntries(
        ['geosite', 'geoip', 'mmdb', 'asn'].map((key) => [key, { type: 'string' }]),
      ),
    },
    proxies: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'type'],
        properties: {
          name: { type: 'string', minLength: 1 },
          type: { type: 'string' },
          server: { type: 'string', minLength: 1 },
          port: { anyOf: [{ type: 'integer', minimum: 1, maximum: 65535 }, { type: 'string' }] },
        },
      },
    },
    'proxy-groups': {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'type'],
        properties: {
          name: { type: 'string', minLength: 1 },
          type: { type: 'string' },
          proxies: { type: 'array', items: { type: 'string' } },
          use: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    'proxy-providers': {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['type'],
        properties: {
          type: { enum: ['http', 'file', 'inline'] },
          url: { type: 'string', minLength: 1 },
          interval: { type: 'integer', minimum: 0 },
        },
      },
    },
    'rule-providers': {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['type', 'behavior'],
        properties: {
          type: { enum: ['http', 'file', 'inline'] },
          behavior: { enum: ['domain', 'ipcidr', 'classical'] },
          format: { enum: ['yaml', 'text', 'mrs'] },
          url: { type: 'string' },
          path: { type: 'string' },
          interval: { type: 'integer', minimum: 0 },
          payload: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    rules: { type: 'array', items: { type: 'string' } },
    'sub-rules': {
      type: 'object',
      additionalProperties: { type: 'array', items: { type: 'string' } },
    },
    dns: {
      type: 'object',
      properties: {
        enable: { type: 'boolean' },
        'enhanced-mode': { enum: ['normal', 'redir-host', 'fake-ip'] },
        nameserver: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
    },
  },
})

export function parse(text: string) {
  return parseDocument(text, { keepSourceTokens: true, uniqueKeys: true, merge: true })
}
export function analyze(text: string): Analysis {
  try {
    const doc = parse(text)
    if (doc.errors.length)
      return { config: null, errors: doc.errors.map((e) => e.message), warnings: [] }
    if (!isMap(doc.contents))
      return { config: null, errors: ['配置根节点必须是一个 YAML 映射。'], warnings: [] }
    const config = doc.toJS({ maxAliasCount: 100 }) as Config
    if (!check(config))
      return {
        config: null,
        errors: (check.errors || []).map((e) => `${e.instancePath || '/'} ${e.message}`),
        warnings: [],
      }
    const warnings = doc.warnings.map((e) => e.message)
    const names = [
      ...(config.proxies || []).map((p) => p.name),
      ...(config['proxy-groups'] || []).map((g) => g.name),
    ]
    const known = new Set([
      'DIRECT',
      'REJECT',
      'REJECT-DROP',
      'PASS',
      'GLOBAL',
      'COMPATIBLE',
      ...names,
    ])
    const errors: string[] = []
    errors.push(...validateRuleProviders(config))
    for (const [i, name] of names.entries())
      if (
        !name.trim() ||
        ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'GLOBAL', 'COMPATIBLE'].includes(name) ||
        names.indexOf(name) !== i
      )
        errors.push(`名称为空、重复或占用保留名称：${name}`)
    for (const g of config['proxy-groups'] || [])
      for (const p of g.proxies || [])
        if (!known.has(p)) errors.push(`${g.name} 引用了不存在的节点或代理组：${p}`)
    for (const [name, provider] of Object.entries(config['proxy-providers'] || {})) {
      if (provider.type === 'http' && !/^https?:\/\//.test(provider.url || ''))
        errors.push(`订阅 ${name} 缺少有效的 HTTP(S) 链接`)
    }
    for (const g of config['proxy-groups'] || [])
      for (const name of g.use || [])
        if (!Object.hasOwn(config['proxy-providers'] || {}, name))
          errors.push(`${g.name} 引用了不存在的订阅：${name}`)
    const graph = new Map((config['proxy-groups'] || []).map((g) => [g.name, g.proxies || []]))
    for (const proxy of config.proxies || [])
      graph.set(
        proxy.name,
        typeof proxy['dialer-proxy'] === 'string' && proxy['dialer-proxy']
          ? [proxy['dialer-proxy']]
          : [],
      )
    for (const ref of outboundReferences(config))
      if (!known.has(String(ref.value)))
        errors.push(`${ref.label} 引用了不存在的目标：${ref.value}`)
    const visiting = new Set<string>(),
      visited = new Set<string>()
    const walk = (name: string): boolean => {
      if (visiting.has(name)) return true
      if (visited.has(name) || !graph.has(name)) return false
      visiting.add(name)
      for (const ref of graph.get(name)!) if (walk(ref)) return true
      visiting.delete(name)
      visited.add(name)
      return false
    }
    if ([...graph.keys()].some(walk)) errors.push('代理组或链式代理之间存在循环引用，请调整引用。')
    const subGraph = new Map(
      Object.keys(config['sub-rules'] || {}).map((name) => [name, [] as string[]]),
    )
    for (const row of ruleRows(config)) {
      const { type, target } = ruleParts(row.value)
      if (type === 'SUB-RULE') {
        if (!Object.hasOwn(config['sub-rules'] || {}, target))
          errors.push(`${row.label} 的子规则不存在：${target}`)
        if (row.path[0] === 'sub-rules') subGraph.get(String(row.path[1]))!.push(target)
      } else if (!target || !known.has(target)) errors.push(`${row.label}的目标不存在：${target}`)
    }
    graph.clear()
    visiting.clear()
    visited.clear()
    for (const [name, refs] of subGraph) graph.set(name, refs)
    if ([...graph.keys()].some(walk)) errors.push('子规则之间存在循环引用。')
    return { config, errors, warnings }
  } catch (e) {
    return {
      config: null,
      errors: [e instanceof Error ? e.message : 'YAML 解析失败'],
      warnings: [],
    }
  }
}
function checked(text: string) {
  const doc = parse(text)
  if (doc.errors.length || !isMap(doc.contents))
    throw new Error('请先修复 YAML 语法，再使用表单编辑。')
  return doc
}
function safeNode(node: unknown): boolean {
  if (isAlias(node)) return false
  if (
    node &&
    typeof node === 'object' &&
    (('anchor' in node && node.anchor) ||
      ('commentBefore' in node && node.commentBefore) ||
      ('comment' in node && node.comment))
  )
    return false
  if (isMap(node)) return node.items.every((pair) => safeNode(pair.key) && safeNode(pair.value))
  if (isSeq(node)) return node.items.every(safeNode)
  return true
}
function ensureRoundTrip(text: string): string {
  const doc = parse(text)
  if (doc.errors.length) throw new Error('这次修改无法安全保留 YAML 结构，请使用源码编辑。')
  return text
}
function scalarText(value: string | number | boolean | null, previous?: unknown): string {
  const node = new Scalar(value)
  if (typeof value === 'string')
    node.type =
      isScalar(previous) && previous.type === 'QUOTE_SINGLE' ? 'QUOTE_SINGLE' : 'QUOTE_DOUBLE'
  const doc = new Document()
  doc.contents = node
  return doc.toString({ lineWidth: 0 }).trimEnd()
}
export function setValue(
  text: string,
  path: Path,
  value: string | number | boolean | null,
): string {
  const doc = checked(text)
  const node = doc.getIn(path, true)
  // An inherited or aliased field is not a local editable value.
  const parent = path.length === 1 ? doc.contents : doc.getIn(path.slice(0, -1), true)
  if (!isMap(parent) && !isSeq(parent)) throw new Error('引用或继承字段请在 YAML 源码中编辑。')
  for (let depth = 1; depth < path.length; depth++) {
    const ancestor = doc.getIn(path.slice(0, depth), true)
    if (isAlias(ancestor) || (isNode(ancestor) && 'anchor' in ancestor && ancestor.anchor))
      throw new Error('共享锚点或引用对象请在 YAML 源码中编辑。')
    if (
      isMap(ancestor) &&
      ancestor.items.some(
        (pair) =>
          isScalar(pair.key) &&
          (pair.key.source === '<<' ||
            pair.key.value === '<<' ||
            pair.key.tag === 'tag:yaml.org,2002:merge'),
      )
    )
      throw new Error('此对象含有合并键，请在 YAML 源码中编辑，避免改变继承关系。')
  }
  if (node !== undefined) {
    if (!isScalar(node) || !node.range || node.anchor)
      throw new Error('复杂结构或共享锚点请在 YAML 源码中编辑。')
    return ensureRoundTrip(
      text.slice(0, node.range[0]) + scalarText(value, node) + text.slice(node.range[1]),
    )
  }
  if (!isMap(parent) || parent.flow || !parent.range || parent.anchor)
    throw new Error('暂不支持在此结构中新增字段，请使用 YAML 源码。')
  const key = path.at(-1)
  if (typeof key !== 'string') throw new Error('字段不存在')
  const firstKey = parent.items[0]?.key
  const offset = isScalar(firstKey) && firstKey.range ? firstKey.range[0] : parent.range[0]
  const indent = offset - text.lastIndexOf('\n', offset - 1) - 1
  const at = parent.range[1]
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const insert =
    (at > 0 && text[at - 1] !== '\n' ? nl : '') +
    ' '.repeat(indent) +
    `${key}: ${scalarText(value)}${nl}`
  return ensureRoundTrip(text.slice(0, at) + insert + text.slice(at))
}
export function appendItem(text: string, section: string, item: unknown): string {
  const doc = checked(text)
  const seq = doc.get(section, true)
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  if (seq === undefined) {
    return insertMappingField(text, [section], [item])
  }
  if (isSeq(seq) && seq.items.length === 0 && safeNode(seq) && seq.range) {
    const fragment = new Document([item])
      .toString({ lineWidth: 0 })
      .trimEnd()
      .split('\n')
      .map((line) => '  ' + line)
      .join(nl)
    return ensureRoundTrip(text.slice(0, seq.range[0]) + nl + fragment + text.slice(seq.range[1]))
  }
  if (!isSeq(seq) || seq.flow || seq.anchor || !seq.range)
    throw new Error('此列表使用行内或共享结构，请使用 YAML 源码新增。')
  const first = seq.items[0]
  const position = isNode(first) && first.range ? first.range[0] : seq.range[0]
  const lineStart = text.lastIndexOf('\n', position - 1) + 1
  const prefix = text.slice(lineStart, position)
  const indent = prefix.match(/^\s*/)?.[0].length || 2
  const fragment =
    new Document([item])
      .toString({ lineWidth: 0 })
      .trimEnd()
      .split('\n')
      .map((line) => ' '.repeat(indent) + line)
      .join(nl) + nl
  const at = seq.range[1]
  return ensureRoundTrip(
    text.slice(0, at) + (text[at - 1] === '\n' ? '' : nl) + fragment + text.slice(at),
  )
}
function itemRange(text: string, section: string, index: number): [number, number] {
  const seq = checked(text).get(section, true)
  if (!isSeq(seq) || seq.flow || seq.anchor || !seq.range)
    throw new Error('此列表需要使用源码编辑。')
  const item = seq.items[index]
  if (!isNode(item) || !item.range || !safeNode(item))
    throw new Error('此项目含有注释或引用，请在源码中调整。')
  const start = text.lastIndexOf('\n', item.range[0] - 1) + 1
  let end = item.range[2]
  const next = seq.items[index + 1]
  if (isNode(next) && next.range) end = text.lastIndexOf('\n', next.range[0] - 1) + 1
  if (text.slice(start, end).includes('#')) throw new Error('此项目附近包含注释，请在源码中调整。')
  return [start, end]
}
export function removeItem(text: string, section: string, index: number): string {
  const seq = checked(text).get(section, true)
  if (isSeq(seq) && seq.items.length === 1)
    throw new Error('最后一个项目请在源码中删除，并明确是否保留空列表。')
  const [start, end] = itemRange(text, section, index)
  return ensureRoundTrip(text.slice(0, start) + text.slice(end))
}
export function moveItem(text: string, section: string, from: number, to: number): string {
  if (Math.abs(from - to) !== 1) throw new Error('仅支持相邻移动')
  const [a, b] = itemRange(text, section, Math.min(from, to))
  const [c, d] = itemRange(text, section, Math.max(from, to))
  return ensureRoundTrip(
    text.slice(0, a) + text.slice(c, d) + text.slice(b, c) + text.slice(a, b) + text.slice(d),
  )
}
export function addRule(text: string, rule: string): string {
  const rules = analyze(text).config?.rules || []
  const catchAll = rules.findIndex((value) => /^(MATCH|FINAL),/.test(value))
  if (catchAll < 0) return appendItem(text, 'rules', rule)
  if (/^(MATCH|FINAL),/.test(rule)) throw new Error('已有兜底规则，请编辑现有规则。')
  const [start] = itemRange(text, 'rules', catchAll)
  const indent = text.slice(start).match(/^ */)?.[0] || ''
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  return ensureRoundTrip(
    text.slice(0, start) + indent + '- ' + scalarText(rule) + nl + text.slice(start),
  )
}
export function prependRule(text: string, rule: string): string {
  const doc = checked(text)
  const seq = doc.get('rules', true)
  if (!isSeq(seq) || seq.flow || !seq.items.length)
    return patchValue(text, ['rules'], [rule, ...(analyze(text).config?.rules || [])])
  const [start] = itemRange(text, 'rules', 0)
  const indent = text.slice(start).match(/^ */)?.[0] || ''
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  return ensureRoundTrip(
    text.slice(0, start) + indent + '- ' + scalarText(rule) + nl + text.slice(start),
  )
}
export function references(config: Config, name: string): string[] {
  const result: string[] = []
  for (const g of config['proxy-groups'] || [])
    if (g.proxies?.includes(name)) result.push(`代理组 ${g.name}`)
  for (const row of ruleRows(config))
    if (ruleParts(row.value).type !== 'SUB-RULE' && ruleParts(row.value).target === name)
      result.push(row.label)
  result.push(...sourceOnlyReferences(config, name))
  for (const ref of outboundReferences(config)) if (ref.value === name) result.push(ref.label)
  return result
}

// These consumers use embedded syntax rather than a standalone outbound name.
// Detect them before rename/delete; full-source editing keeps their semantics explicit.
function sourceOnlyReferences(config: Config, name: string): string[] {
  const result: string[] = []
  const visit = (value: unknown, path: string[], seen = new WeakSet<object>()) => {
    if (typeof value === 'string') {
      let fragment = value.split('#').slice(1).join('#')
      try {
        fragment = decodeURIComponent(fragment)
      } catch {
        /* preserve malformed source */
      }
      if (fragment.split('&').includes(name)) result.push(path.join(' / '))
    } else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value)
      for (const [key, item] of Object.entries(value)) visit(item, [...path, key], seen)
    }
  }
  visit(config.dns, ['DNS'])
  if (Array.isArray(config.tunnels))
    config.tunnels.forEach((tunnel, i) => {
      if (
        (typeof tunnel === 'string' && tunnel.split(',').at(-1)?.trim() === name) ||
        (tunnel && typeof tunnel === 'object' && tunnel.proxy === name)
      )
        result.push(`隧道 ${i + 1}`)
    })
  return result
}

function outboundReferences(config: Config): { path: Path; value: unknown; label: string }[] {
  const refs: { path: Path; value: unknown; label: string }[] = []
  for (const [i, node] of (config.proxies || []).entries())
    refs.push({
      path: ['proxies', i, 'dialer-proxy'],
      value: node['dialer-proxy'],
      label: `节点 ${node.name} 的链式代理`,
    })
  for (const section of ['proxy-providers', 'rule-providers'] as const)
    for (const [name, provider] of Object.entries(config[section] || {})) {
      refs.push({
        path: [section, name, 'proxy'],
        value: provider.proxy,
        label: `${section} / ${name} 的下载代理`,
      })
      const override = provider.override as Record<string, unknown> | undefined
      if (override)
        refs.push({
          path: [section, name, 'override', 'dialer-proxy'],
          value: override['dialer-proxy'],
          label: `${section} / ${name} 的链式代理`,
        })
      if (Array.isArray(provider.payload))
        provider.payload.forEach((node, i) => {
          if (node && typeof node === 'object')
            refs.push({
              path: [section, name, 'payload', i, 'dialer-proxy'],
              value: node['dialer-proxy'],
              label: `${section} / ${name} / ${i + 1} 的链式代理`,
            })
        })
    }
  if (Array.isArray(config.listeners))
    for (const [i, listener] of config.listeners.entries())
      if (listener && typeof listener === 'object')
        refs.push({
          path: ['listeners', i, 'proxy'],
          value: listener.proxy,
          label: `监听器 ${listener.name || i + 1}`,
        })
  return refs.filter((ref) => typeof ref.value === 'string' && ref.value)
}
export function rename(text: string, section: string, index: number, name: string): string {
  const config = analyze(text).config
  if (!config) throw new Error('请先修复配置')
  const list = config[section] as { name: string }[]
  const old = list[index].name
  if (old === name) return text
  const sourceRefs = sourceOnlyReferences(config, old)
  if (sourceRefs.length)
    throw new Error(`仍被 ${sourceRefs.join('、')} 引用，请在 YAML 源码中一起改名。`)
  if (
    !name.trim() ||
    [...(config.proxies || []), ...(config['proxy-groups'] || [])].some((p) => p.name === name) ||
    ['DIRECT', 'REJECT', 'REJECT-DROP', 'COMPATIBLE', 'GLOBAL', 'PASS'].includes(name)
  )
    throw new Error('名称为空、重复或占用保留名称')
  let next = setValue(text, [section, index, 'name'], name)
  for (const ref of outboundReferences(config))
    if (ref.value === old) next = setValue(next, ref.path, name)
  for (const [i, g] of (config['proxy-groups'] || []).entries())
    for (const [j, p] of (g.proxies || []).entries())
      if (p === old) next = setValue(next, ['proxy-groups', i, 'proxies', j], name)
  for (const [i, g] of (config['proxy-groups'] || []).entries()) {
    const updated = renameOrderedMember(g, old, name)
    if (updated !== g) {
      next = patchValue(next, ['proxy-groups', i, ORDER_KEY], updated[ORDER_KEY])
      next = patchValue(next, ['proxy-groups', i, 'filter'], updated.filter)
    }
  }
  for (const row of ruleRows(config)) {
    const { parts, index, type, target } = ruleParts(row.value)
    if (type !== 'SUB-RULE' && target === old) {
      parts[index] = parts[index].replace(old, name)
      next = setValue(next, row.path, parts.join(','))
    }
  }
  return next
}

function localMapping(doc: ReturnType<typeof parse>, path: Path) {
  for (let depth = 0; depth <= path.length; depth++) {
    const node = depth === 0 ? doc.contents : doc.getIn(path.slice(0, depth), true)
    if (isAlias(node) || (isNode(node) && 'anchor' in node && node.anchor))
      throw new Error('共享结构请在源码中编辑。')
    if (
      isMap(node) &&
      node.items.some(
        (pair) =>
          isScalar(pair.key) &&
          (pair.key.source === '<<' || pair.key.tag === 'tag:yaml.org,2002:merge'),
      )
    )
      throw new Error('合并继承结构请在源码中编辑。')
  }
  const map = path.length ? doc.getIn(path, true) : doc.contents
  if (!isMap(map) || !map.range) throw new Error('此字段需要在源码中编辑。')
  return map
}

// Form edits replace only the selected scalar or insert/remove its local mapping pair.
// Refuse shared structures and comment-bearing deletions instead of reserializing them.
function removeMappingField(text: string, path: Path): string {
  const doc = checked(text)
  const parent = localMapping(doc, path.slice(0, -1))
  const pair = parent.items.find((p) => isScalar(p.key) && p.key.value === path.at(-1))
  if (!pair) return text
  if (parent.flow && safeNode(parent)) {
    const copy = parent.toJSON() as Record<string, unknown>
    delete copy[String(path.at(-1))]
    return ensureRoundTrip(
      text.slice(0, parent.range![0]) + JSON.stringify(copy) + text.slice(parent.range![1]),
    )
  }
  if (
    parent.flow ||
    !isScalar(pair.key) ||
    !pair.key.range ||
    !isNode(pair.value) ||
    !pair.value.range ||
    !safeNode(pair.key) ||
    !safeNode(pair.value)
  )
    throw new Error('此字段含注释、行内结构或共享引用，请在 YAML 源码中移除。')
  if (path.length > 1 && parent.items.length === 1)
    return removeMappingField(text, path.slice(0, -1))
  const start = text.lastIndexOf('\n', pair.key.range[0] - 1) + 1
  if (text.slice(start, pair.key.range[0]).trim()) throw new Error('此字段请在 YAML 源码中移除。')
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  return ensureRoundTrip(
    text.slice(0, start) +
      (parent.items.length === 1 ? '{}' + nl : '') +
      text.slice(pair.value.range[2]),
  )
}

function insertMappingField(text: string, path: Path, value: unknown): string {
  const doc = checked(text)
  const parent = localMapping(doc, path.slice(0, -1))
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const fragment = new Document({ [path.at(-1)!]: value }).toString({ lineWidth: 0 }).trimEnd()
  if (parent.flow) {
    if (!safeNode(parent)) throw new Error('行内映射请在 YAML 源码中新增字段。')
    if (parent.items.length) {
      const at = parent.range![1] - 1
      return ensureRoundTrip(
        text.slice(0, at) +
          ', ' +
          scalarText(String(path.at(-1))) +
          ': ' +
          JSON.stringify(value) +
          text.slice(at),
      )
    }
    // Expand an empty map so subsequent form edits can add sibling fields.
    let replacement = fragment.replace(/\n/g, nl)
    if (path.length > 1) {
      const rawOwner = doc.getIn(path.slice(0, -2), true)
      if (isSeq(rawOwner)) {
        const indent = parent.range![0] - text.lastIndexOf('\n', parent.range![0] - 1) - 1
        replacement = fragment
          .split('\n')
          .map((line, i) => (i ? ' '.repeat(indent) : '') + line)
          .join(nl)
        return ensureRoundTrip(
          text.slice(0, parent.range![0]) + replacement + text.slice(parent.range![1]),
        )
      }
      const owner = localMapping(doc, path.slice(0, -2))
      if (owner.flow) throw new Error('行内映射请在 YAML 源码中新增字段。')
      const pair = owner.items.find((p) => isScalar(p.key) && p.key.value === path.at(-2))
      if (!pair || !isScalar(pair.key) || !pair.key.range)
        throw new Error('此字段请在 YAML 源码中编辑。')
      const offset = pair.key.range[0]
      const indent = offset - text.lastIndexOf('\n', offset - 1) + 1
      replacement =
        nl +
        fragment
          .split('\n')
          .map((line) => ' '.repeat(indent) + line)
          .join(nl)
    }
    return ensureRoundTrip(
      text.slice(0, parent.range![0]) + replacement + text.slice(parent.range![1]),
    )
  }
  const first = parent.items[0]?.key
  const offset = isScalar(first) && first.range ? first.range[0] : parent.range![0]
  const indent = offset - text.lastIndexOf('\n', offset - 1) - 1
  const at = parent.range![1]
  return ensureRoundTrip(
    text.slice(0, at) +
      (at && text[at - 1] !== '\n' ? nl : '') +
      fragment
        .split('\n')
        .map((line) => ' '.repeat(indent) + line)
        .join(nl) +
      nl +
      text.slice(at),
  )
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => sameValue(v, b[i]))
  if (
    a &&
    b &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const left = a as Record<string, unknown>,
      right = b as Record<string, unknown>
    return (
      Object.keys(left).length === Object.keys(right).length &&
      Object.keys(left).every((k) => Object.hasOwn(right, k) && sameValue(left[k], right[k]))
    )
  }
  return false
}

/** Patch only changed values in the original YAML; never serialize the whole document. */
export function patchValue(text: string, path: Path, value: unknown): string {
  const doc = checked(text)
  const node = path.length ? doc.getIn(path, true) : doc.contents
  const old = isNode(node) ? node.toJSON() : node
  // Resolve aliases for comparison, but refuse shared mutations below.
  const resolved = path.reduce<unknown>(
    (v, k) => (v && typeof v === 'object' ? (v as Record<string | number, unknown>)[k] : undefined),
    doc.toJS({ maxAliasCount: 100 }),
  )
  if (sameValue(resolved, value)) return text
  if (path.length) {
    const parent = doc.getIn(path.slice(0, -1), true)
    if (isMap(parent)) localMapping(doc, path.slice(0, -1))
    else {
      for (let i = 0; i < path.length; i++) {
        const ancestor = i ? doc.getIn(path.slice(0, i), true) : doc.contents
        if (isAlias(ancestor) || (isNode(ancestor) && 'anchor' in ancestor && ancestor.anchor))
          throw new Error('共享引用请在 YAML 源码中编辑。')
      }
    }
  }
  if (value === undefined) return removeMappingField(text, path)
  if (node === undefined) return insertMappingField(text, path, value)
  if (
    isMap(node) &&
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length
  ) {
    localMapping(doc, path)
    const previous = old as Record<string, unknown>,
      desired = value as Record<string, unknown>
    let next = text
    // Add before remove so a map is not temporarily removed when replacing its only key.
    for (const key of Object.keys(desired)) next = patchValue(next, [...path, key], desired[key])
    for (const key of Object.keys(previous))
      if (!Object.hasOwn(desired, key)) next = patchValue(next, [...path, key], undefined)
    return next
  }
  if (isSeq(node) && Array.isArray(value) && node.items.length === value.length) {
    if (node.anchor) throw new Error('共享列表请在 YAML 源码中编辑。')
    return value.reduce((next, item, i) => patchValue(next, [...path, i], item), text)
  }
  if (
    isScalar(node) &&
    (value === null || ['string', 'number', 'boolean'].includes(typeof value))
  ) {
    return setValue(text, path, value as string | number | boolean | null)
  }
  if (!isNode(node) || !node.range || !safeNode(node))
    throw new Error('此结构含有注释或共享引用，请在 YAML 源码中调整。')
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  let replacement: string
  if ((isMap(node) || isSeq(node)) && !node.flow) {
    const indent = node.range[0] - text.lastIndexOf('\n', node.range[0] - 1) - 1
    replacement = new Document(value)
      .toString({ lineWidth: 0 })
      .trimEnd()
      .split('\n')
      .map((line, i) => (i ? ' '.repeat(indent) : '') + line)
      .join(nl)
    if (text[node.range[1] - 1] === '\n') replacement += nl
  } else replacement = JSON.stringify(value)
  return ensureRoundTrip(text.slice(0, node.range[0]) + replacement + text.slice(node.range[1]))
}

export function updateGeoSettings(text: string, changes: GeoSettings): string {
  let next = text
  for (const key of [
    'geodata-mode',
    'geodata-loader',
    'geo-auto-update',
    'geo-update-interval',
  ] as const) {
    if (!Object.hasOwn(changes, key)) continue
    const value = changes[key]
    if (value !== undefined) {
      if (key === 'geo-update-interval' && (!Number.isSafeInteger(value) || Number(value) < 1))
        throw new Error('GEO 更新间隔必须是正整数，单位为小时。')
      if (key === 'geodata-loader' && value !== 'memconservative' && value !== 'standard')
        throw new Error('请选择有效的 GEO 加载方式。')
      if ((key === 'geodata-mode' || key === 'geo-auto-update') && typeof value !== 'boolean')
        throw new Error('请选择有效的 GEO 设置。')
    }
    const doc = checked(next)
    localMapping(doc, [])
    const node = doc.get(key, true)
    if ((isScalar(node) && node.value === value) || (node === undefined && value === undefined))
      continue
    next =
      value === undefined
        ? removeMappingField(next, [key])
        : node === undefined
          ? insertMappingField(next, [key], value)
          : setValue(next, [key], value)
  }
  return next
}

export function setGeoSource(text: string, key: GeoSource, value: string): string {
  const url = value.trim()
  if (url) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error('请输入有效的 HTTP(S) 数据来源。')
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
      throw new Error('请输入 HTTP(S) 数据来源，不支持 URL 用户信息。')
  }
  const doc = checked(text)
  localMapping(doc, [])
  const section = doc.get('geox-url', true)
  if (section === undefined)
    return url ? insertMappingField(text, ['geox-url'], { [key]: url }) : text
  localMapping(doc, ['geox-url'])
  const node = doc.getIn(['geox-url', key], true)
  if ((isScalar(node) && node.value === url) || (node === undefined && !url)) return text
  if (!url) return removeMappingField(text, ['geox-url', key])
  return node === undefined
    ? insertMappingField(text, ['geox-url', key], url)
    : setValue(text, ['geox-url', key], url)
}

// Write one list without serializing the containing object or document.
export function setStringList(text: string, path: Path, values: string[]): string {
  const doc = checked(text)
  const parent = localMapping(doc, path.slice(0, -1))
  const value = `[${values.map((v) => scalarText(v)).join(', ')}]`
  const node = doc.getIn(path, true)
  if (node !== undefined) {
    if (!isSeq(node) || !node.range || !safeNode(node))
      throw new Error('列表含注释或共享引用，请在源码中编辑。')
    const suffix = node.flow ? '' : text.includes('\r\n') ? '\r\n' : '\n'
    return ensureRoundTrip(
      text.slice(0, node.range[0]) + value + suffix + text.slice(node.range[1]),
    )
  }
  if (parent.flow) throw new Error('行内映射请在源码中新增列表。')
  const first = parent.items[0]?.key
  const position = isScalar(first) && first.range ? first.range[0] : parent.range![0]
  const indent = position - text.lastIndexOf('\n', position - 1) - 1
  const at = parent.range![1]
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  return ensureRoundTrip(
    text.slice(0, at) +
      (text[at - 1] === '\n' ? '' : nl) +
      ' '.repeat(indent) +
      `${scalarText(String(path.at(-1)))}: ${value}${nl}` +
      text.slice(at),
  )
}

export function saveProvider(
  text: string,
  original: string | null,
  name: string,
  provider: Provider,
): string {
  name = name.trim()
  const config = analyze(text).config
  if (!config) throw new Error('请先修复配置。')
  const providers = config['proxy-providers'] || {}
  if (!name || (name !== original && Object.hasOwn(providers, name)))
    throw new Error('订阅名称为空或重复。')
  if (provider.type !== 'http') throw new Error('文件和内联集合请在源码中编辑。')
  const url = new URL(String(provider.url || ''))
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('请输入 HTTP(S) 订阅链接，不支持 URL 用户信息。')
  if (
    provider.interval !== undefined &&
    (!Number.isInteger(provider.interval) || provider.interval < 0)
  )
    throw new Error('更新间隔必须是非负整数。')
  if (original !== null) {
    let next = text
    const map = localMapping(checked(next), ['proxy-providers'])
    const pair = map.items.find((p) => isScalar(p.key) && p.key.value === original)
    if (!pair || !isScalar(pair.key) || !pair.key.range || pair.key.anchor)
      throw new Error('找不到可编辑的订阅。')
    if (original !== name) {
      next = ensureRoundTrip(
        next.slice(0, pair.key.range[0]) +
          scalarText(name, pair.key) +
          next.slice(pair.key.range[1]),
      )
      for (const [i, group] of (config['proxy-groups'] || []).entries())
        for (const [j, ref] of (group.use || []).entries())
          if (ref === original) next = setValue(next, ['proxy-groups', i, 'use', j], name)
    }
    for (const key of ['url', 'interval'] as const)
      if (provider[key] !== providers[original][key])
        next =
          provider[key] === undefined
            ? removeMappingField(next, ['proxy-providers', name, key])
            : setValue(next, ['proxy-providers', name, key], provider[key]!)
    return next
  }
  const doc = checked(text)
  localMapping(doc, [])
  const existing = doc.get('proxy-providers', true)
  if (existing === undefined) {
    const nl = text.includes('\r\n') ? '\r\n' : '\n'
    const fragment = new Document({ 'proxy-providers': { [name]: provider } })
      .toString({ lineWidth: 0 })
      .replace(/\n/g, nl)
    return ensureRoundTrip(text + (text.endsWith('\n') ? nl : nl + nl) + fragment)
  }
  const map = localMapping(doc, ['proxy-providers'])
  if (map.flow && map.items.length) throw new Error('行内订阅映射请在源码中新增。')
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const fragment =
    new Document({ [name]: provider })
      .toString({ lineWidth: 0 })
      .trimEnd()
      .split('\n')
      .map((line) => '  ' + line)
      .join(nl) + nl
  if (map.flow)
    return ensureRoundTrip(
      text.slice(0, map.range![0]) + nl + fragment.trimEnd() + text.slice(map.range![1]),
    )
  const at = map.range![1]
  return ensureRoundTrip(
    text.slice(0, at) + (text[at - 1] === '\n' ? '' : nl) + fragment + text.slice(at),
  )
}

export function removeProvider(text: string, name: string): string {
  const config = analyze(text).config
  const references = (config?.['proxy-groups'] || [])
    .filter((g) => g.use?.includes(name))
    .map((g) => g.name)
  if (references.length)
    throw new Error(`订阅仍被代理组 ${references.join('、')} 使用，请先取消引用。`)
  const map = localMapping(checked(text), ['proxy-providers'])
  if (map.flow) throw new Error('行内订阅映射请在源码中删除。')
  const pair = map.items.find((p) => isScalar(p.key) && p.key.value === name)
  if (
    !pair ||
    !isScalar(pair.key) ||
    !pair.key.range ||
    !isNode(pair.value) ||
    !pair.value.range ||
    !safeNode(pair.key) ||
    !safeNode(pair.value)
  )
    throw new Error('订阅包含注释或引用，请在源码中删除。')
  const start = text.lastIndexOf('\n', pair.key.range[0] - 1) + 1
  const end = pair.value.range[2]
  return ensureRoundTrip(
    text.slice(0, start) +
      (map.items.length === 1 ? '  {}' + (text.includes('\r\n') ? '\r\n' : '\n') : '') +
      text.slice(end),
  )
}

export function saveRuleProvider(
  text: string,
  original: string | null,
  name: string,
  provider: RuleProvider,
): string {
  name = name.trim()
  const config = analyze(text).config
  if (!config) throw new Error('请先修复配置结构。')
  const providers = config['rule-providers'] || {}
  if (!name || /[,()\r\n]/.test(name) || (name !== original && Object.hasOwn(providers, name)))
    throw new Error('规则集名称不能为空、重复或包含逗号、括号和换行。')
  const problems = ruleProviderErrors(provider)
  const candidate = { ...providers }
  if (original !== null) delete candidate[original]
  Object.defineProperty(candidate, name, { value: provider, enumerable: true, configurable: true })
  problems.push(
    ...validateRuleProviders({ 'rule-providers': candidate }).filter((error) =>
      error.includes('相同文件路径'),
    ),
  )
  if (problems.length) throw new Error(problems.join('；'))
  const doc = checked(text)
  localMapping(doc, [])
  if (original === null) {
    const clean = Object.fromEntries(
      Object.entries(provider).filter(([, value]) => value !== undefined),
    )
    return doc.get('rule-providers', true) === undefined
      ? insertMappingField(text, ['rule-providers'], { [name]: clean })
      : insertMappingField(text, ['rule-providers', name], clean)
  }
  if (!Object.hasOwn(providers, original)) throw new Error('规则集已不存在。')
  if (provider.type !== providers[original].type)
    throw new Error('修改已有规则集的来源类型请使用 YAML 源码。')
  localMapping(doc, ['rule-providers', original])
  const refs = name === original ? [] : ruleProviderReferences(config, original)
  if (refs.some((ref) => !ref.editable))
    throw new Error('规则集用于复杂规则、DNS 或其他设置，请在 YAML 源码中同步改名。')
  let next = text
  if (name !== original) {
    const map = localMapping(doc, ['rule-providers'])
    const pair = map.items.find((p) => isScalar(p.key) && p.key.value === original)
    if (!pair || !isScalar(pair.key) || !pair.key.range || pair.key.anchor)
      throw new Error('共享名称请在 YAML 源码中修改。')
    next = ensureRoundTrip(
      next.slice(0, pair.key.range[0]) + scalarText(name, pair.key) + next.slice(pair.key.range[1]),
    )
    for (const ref of refs) {
      const updated = ref.value.replace(
        /^(RULE-SET\s*,\s*)[^,]+/,
        (_, prefix: string) => prefix + name,
      )
      next = setValue(next, ref.path, updated)
    }
  }
  for (const key of ['behavior', 'format', 'url', 'path', 'interval', 'payload'] as const) {
    const old = providers[original][key],
      value = provider[key]
    if (JSON.stringify(old) === JSON.stringify(value)) continue
    const path = ['rule-providers', name, key]
    if (value === undefined) next = removeMappingField(next, path)
    else if (Array.isArray(value)) next = setStringList(next, path, value)
    else if (checked(next).getIn(path, true) === undefined)
      next = insertMappingField(next, path, value)
    else next = setValue(next, path, value)
  }
  return next
}

export function removeRuleProvider(text: string, name: string): string {
  const config = analyze(text).config
  if (!config) throw new Error('请先修复配置结构。')
  const refs = ruleProviderReferences(config, name)
  if (refs.length)
    throw new Error(`规则集仍被 ${refs.map((ref) => ref.label).join('、')} 使用，请先移除引用。`)
  return removeMappingField(text, ['rule-providers', name])
}
