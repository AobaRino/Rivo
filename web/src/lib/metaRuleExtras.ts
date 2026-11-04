import { isMap, isScalar, isSeq, parseDocument, stringify } from 'yaml'
import type { YAMLMap, YAMLSeq } from 'yaml'
import catalog from '../../../rules/catalog.json'
import type { Config } from './document'
import type { RuleProvider } from './ruleProviders'

export const extraMarker = 'x-rivo-rule-extra'

export function extraRuleURL(file: string): string {
  return `https://raw.githubusercontent.com/AobaRino/Rivo/rules/${file}.list`
}

export function extraProviderName(name: string): string {
  return `${name}-extra`
}

const officialBase = 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/'
const domainFiles = new Set(
  [
    ...catalog.baseDomains,
    ...Object.values(catalog.services).flatMap((service) => [
      ...service.domains,
      ...('directDomains' in service ? service.directDomains : []),
    ]),
  ].map((name) => (name.startsWith('geosite/') ? name : `geosite/${name}`)),
)

export function isMetaRuleExtra(provider: RuleProvider): boolean {
  return (
    provider.type === 'http' &&
    provider.behavior === 'classical' &&
    provider.format === 'text' &&
    [...domainFiles].some((file) => provider.url === extraRuleURL(file))
  )
}

type SimpleRule = { provider: string; target: string; options: string[] }
type Binding = { source: string; name: string; value?: RuleProvider }
type Sequence = { path: string[]; rules: string[] }
type Insertion = { offset: number; text: string }

function simpleRule(value: unknown): SimpleRule | undefined {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) return
  const [type, provider, target, ...options] = value.split(',').map((part) => part.trim())
  if (
    type === 'RULE-SET' &&
    provider &&
    target &&
    options.every((option) => option === 'no-resolve' || option === 'src')
  )
    return { provider, target, options }
}

function sequences(config: Config): Sequence[] {
  return [
    { path: ['rules'], rules: config.rules || [] },
    ...Object.entries(config['sub-rules'] || {}).map(([name, rules]) => ({
      path: ['sub-rules', name],
      rules,
    })),
  ]
}

function sameRule(value: unknown, name: string, rule: SimpleRule) {
  const next = simpleRule(value)
  return (
    next?.provider === name &&
    next.target === rule.target &&
    next.options.join(',') === rule.options.join(',')
  )
}

function sourceFile(provider: RuleProvider): string | undefined {
  if (
    provider.type !== 'http' ||
    provider.behavior !== 'domain' ||
    provider.format !== 'mrs' ||
    typeof provider.url !== 'string' ||
    !provider.url.startsWith(officialBase) ||
    !provider.url.endsWith('.mrs')
  )
    return
  const file = provider.url.slice(officialBase.length, -4)
  return domainFiles.has(file) ? file : undefined
}

function bindings(config: Config): Map<string, Binding> {
  const providers = config['rule-providers'] || {}
  const referenced = new Set(
    sequences(config).flatMap(({ rules }) =>
      rules.flatMap((value) => {
        const rule = simpleRule(value)
        return rule ? [rule.provider] : []
      }),
    ),
  )
  const result = new Map<string, Binding>()
  const planned = new Map<string, Binding>()
  for (const [source, provider] of Object.entries(providers)) {
    const file = sourceFile(provider)
    if (!file || !referenced.has(source)) continue
    const url = extraRuleURL(file)
    const matching = Object.entries(providers).filter(
      ([, value]) => value[extraMarker] === source || value.url === url,
    )
    if (matching.length > 1)
      throw new Error(`规则集「${source}」有多个补充规则集，请在 YAML 源码中确认。`)
    const existing = matching[0]
    if (existing) {
      if (
        existing[1].type !== 'http' ||
        existing[1].behavior !== 'classical' ||
        existing[1].format !== 'text'
      )
        throw new Error(`规则集「${existing[0]}」的补充规则类型已改变，请在 YAML 源码中确认。`)
      const owner = existing[1][extraMarker]
      if (
        existing[1].url !== url ||
        (Object.hasOwn(existing[1], extraMarker) && (typeof owner !== 'string' || !owner)) ||
        (typeof owner === 'string' && providers[owner] && sourceFile(providers[owner]) !== file)
      )
        throw new Error(`规则集「${existing[0]}」的补充来源或归属有冲突，请在 YAML 源码中确认。`)
      result.set(source, { source, name: existing[0] })
      continue
    }
    // Two names for the same upstream collection can share one new companion.
    const shared = planned.get(url)
    if (shared) {
      const previous = providers[shared.source]
      if (
        ['proxy', 'header', 'x-manager-service'].some(
          (key) => JSON.stringify(previous[key]) !== JSON.stringify(provider[key]),
        ) ||
        (previous.interval ?? 86400) !== (provider.interval ?? 86400)
      )
        throw new Error(
          `规则集「${source}」与「${shared.source}」来源相同但下载设置不同，请在 YAML 源码中确认。`,
        )
      result.set(source, { source, name: shared.name })
      continue
    }
    const name = extraProviderName(source)
    if (Object.hasOwn(providers, name) || [...planned.values()].some((item) => item.name === name))
      throw new Error(`规则集名称「${name}」已被占用，请先改名。`)
    const value: RuleProvider = {
      type: 'http',
      behavior: 'classical',
      format: 'text',
      url,
      interval: Object.hasOwn(provider, 'interval') ? provider.interval : 86400,
      [extraMarker]: source,
    }
    for (const key of ['proxy', 'header', 'x-manager-service'])
      if (Object.hasOwn(provider, key)) value[key] = provider[key]
    const binding = { source, name, value }
    planned.set(url, binding)
    result.set(source, binding)
  }
  return result
}

/** Only ordinary routing rules are upgraded; DNS and nested logic remain unchanged. */
export function needsMetaRuleExtras(config: Config): boolean {
  try {
    const mapping = bindings(config)
    return (
      [...mapping.values()].some((binding) => binding.value) ||
      sequences(config).some(({ rules }) =>
        rules.some((value, index) => {
          const rule = simpleRule(value)
          const binding = rule && mapping.get(rule.provider)
          return binding && !sameRule(rules[index + 1], binding.name, rule!)
        }),
      )
    )
  } catch {
    // Keep the action visible so its normal error path can explain the collision.
    return true
  }
}

function addAfterRule(
  text: string,
  sequence: YAMLSeq,
  index: number,
  value: string,
  newline: string,
): Insertion {
  const item = sequence.items[index]
  if (sequence.anchor || !isScalar(item) || !item.range || item.anchor)
    throw new Error('规则包含共享引用，请在 YAML 源码中补充，避免改变其他引用。')
  if (sequence.flow) {
    if (item.comment)
      throw new Error('流式规则包含行内注释，请在 YAML 源码中补充，保留注释对应关系。')
    return { offset: item.range[1], text: `, ${JSON.stringify(value)}` }
  }
  const token = sequence.srcToken
  if (token?.type !== 'block-seq') throw new Error('无法定位原规则，请在 YAML 源码中补充。')
  const dash = token.items[index].start.find((part) => part.type === 'seq-item-ind')
  if (!dash) throw new Error('无法定位原规则，请在 YAML 源码中补充。')
  const offset = item.range[2]
  const prefix = offset > 0 && text[offset - 1] !== '\n' ? newline : ''
  return {
    offset,
    text: `${prefix}${' '.repeat(dash.indent)}- ${JSON.stringify(value)}${newline}`,
  }
}

function addProviders(text: string, map: YAMLMap, added: Binding[], newline: string): Insertion {
  if (map.anchor || !map.range)
    throw new Error('规则集包含共享引用，请在 YAML 源码中补充，避免改变其他引用。')
  if (map.flow) {
    const token = map.srcToken
    if (token?.type !== 'flow-collection') throw new Error('无法定位规则集。')
    const closing = token.end.find((part) => part.type === 'flow-map-end')
    if (!closing) throw new Error('无法定位规则集。')
    const last = token.items.at(-1)
    const trailingComma = last && !last.key && !last.value
    return {
      offset: closing.offset,
      text:
        (map.items.length && !trailingComma ? ', ' : '') +
        added
          .map(({ name, value }) => `${JSON.stringify(name)}: ${JSON.stringify(value)}`)
          .join(', '),
    }
  }
  const token = map.srcToken
  if (token?.type !== 'block-map') throw new Error('无法定位规则集。')
  const offset = map.range[2]
  const serialized = stringify(Object.fromEntries(added.map(({ name, value }) => [name, value])), {
    lineWidth: 0,
  })
    .trimEnd()
    .split('\n')
    .map((line) => `${' '.repeat(token.indent)}${line}`)
    .join(newline)
  return {
    offset,
    text: `${offset > 0 && text[offset - 1] !== '\n' ? newline : ''}${serialized}${newline}`,
  }
}

/** Adds companions without serializing or replacing any existing YAML nodes. */
export function upgradeMetaRuleExtras(text: string): string {
  const doc = parseDocument(text, { keepSourceTokens: true, uniqueKeys: true, merge: true })
  if (doc.errors.length || !isMap(doc.contents)) throw new Error('请先修复 YAML 结构。')
  const config = doc.toJS({ maxAliasCount: 100 }) as Config
  const mapping = bindings(config)
  if (!mapping.size) return text
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const insertions: Insertion[] = []
  for (const { path, rules } of sequences(config)) {
    for (const [index, value] of rules.entries()) {
      const rule = simpleRule(value)
      const binding = rule && mapping.get(rule.provider)
      if (!rule || !binding || sameRule(rules[index + 1], binding.name, rule)) continue
      const sequence = doc.getIn(path, true)
      if (!isSeq(sequence)) throw new Error('规则包含共享引用，请在 YAML 源码中补充。')
      if (
        doc.contents.anchor ||
        path.slice(0, -1).some((_, index) => {
          const parent = doc.getIn(path.slice(0, index + 1), true)
          return isMap(parent) && parent.anchor
        })
      )
        throw new Error('规则包含共享引用，请在 YAML 源码中补充，避免改变其他引用。')
      insertions.push(
        addAfterRule(
          text,
          sequence,
          index,
          ['RULE-SET', binding.name, rule.target, ...rule.options].join(','),
          newline,
        ),
      )
    }
  }
  const added = [...mapping.values()].filter((binding) => binding.value)
  if (added.length) {
    const providers = doc.get('rule-providers', true)
    if (!isMap(providers)) throw new Error('规则集包含共享引用，请在 YAML 源码中补充。')
    insertions.push(addProviders(text, providers, added, newline))
  }
  let result = text
  for (const insertion of insertions.sort((a, b) => b.offset - a.offset))
    result = result.slice(0, insertion.offset) + insertion.text + result.slice(insertion.offset)
  const updated = parseDocument(result, { uniqueKeys: true, merge: true })
  if (updated.errors.length) throw new Error('无法安全补充此 YAML，请在源码中调整。')
  return result
}
