import { isAlias, isNode, isSeq } from 'yaml'
import {
  analyze,
  appendItem,
  parse,
  patchValue,
  references,
  removeItem,
  removeRuleProvider,
  saveRuleProvider,
} from './document'
import type { Config, Group } from './document'
import type { RuleProvider } from './ruleProviders'
import { ruleProviderReferences } from './ruleProviders'
import { ruleParts } from './rules'
import { directException } from './directExceptions'
import {
  ownedService,
  serviceMarker,
  serviceOwner,
  serviceProviders,
  serviceRules,
} from './serviceRules'
import type { ServiceProvider, ServiceSelections } from './serviceRules'

export const metaRulesSource = 'https://github.com/MetaCubeX/meta-rules-dat'
const baseURL = 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo'
export const metaRuleSets = [
  {
    name: 'metacubex-private-domain',
    label: '局域网域名',
    file: 'geosite/private',
    behavior: 'domain',
    direct: true,
  },
  {
    name: 'metacubex-private-ip',
    label: '局域网 IP',
    file: 'geoip/private',
    behavior: 'ipcidr',
    direct: true,
  },
  {
    name: 'metacubex-cn-domain',
    label: '国内域名',
    file: 'geosite/cn',
    behavior: 'domain',
    direct: true,
  },
  {
    name: 'metacubex-foreign-domain',
    label: '国外域名',
    file: 'geosite/geolocation-!cn',
    behavior: 'domain',
    direct: false,
  },
  { name: 'metacubex-cn-ip', label: '国内 IP', file: 'geoip/cn', behavior: 'ipcidr', direct: true },
] as const

export function metaRuleURL(file: string) {
  return `${baseURL}/${file}.mrs`
}

export function metaRuleLabel(provider: RuleProvider) {
  return [...metaRuleSets, ...serviceRules.flatMap(serviceProviders)].find(
    (entry) => provider.url === metaRuleURL(entry.file),
  )?.label
}

// Exclude service groups and any outbound depending on them, so generated
// selectors cannot form a cycle through an existing group or dialer-proxy.
export function presetExits(config: Config): string[] {
  const outbounds = [...(config['proxy-groups'] || []), ...(config.proxies || [])]
  const blocked = new Set((config['proxy-groups'] || []).filter(ownedService).map((g) => g.name))
  let changed = true
  while (changed) {
    changed = false
    for (const outbound of outbounds) {
      const dependencies = [
        ...(Array.isArray(outbound.proxies) ? (outbound.proxies as string[]) : []),
        outbound['dialer-proxy'],
      ]
      if (
        !blocked.has(outbound.name) &&
        dependencies.some((name) => typeof name === 'string' && blocked.has(name))
      ) {
        blocked.add(outbound.name)
        changed = true
      }
    }
  }
  return [
    'DIRECT',
    ...outbounds
      .filter(
        (outbound) =>
          !blocked.has(outbound.name) &&
          !['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'GLOBAL', 'COMPATIBLE'].includes(
            outbound.name,
          ) &&
          outbound.name.trim() === outbound.name &&
          !/[,\r\n]/.test(outbound.name),
      )
      .map((outbound) => outbound.name),
  ]
}

export function presetProxyGroups(config: Config) {
  const eligible = new Set(presetExits(config))
  return (config['proxy-groups'] || []).filter(
    (group) => eligible.has(group.name) && group.name !== 'DIRECT',
  )
}

export function defaultPresetProxy(config: Config) {
  const groups = presetProxyGroups(config)
  const last = config.rules?.at(-1)
  const target = last && ruleParts(last).type === 'MATCH' ? ruleParts(last).target : ''
  const configured = groups.find(
    (group) =>
      group.name === target &&
      config.rules?.some((rule) => rule === `RULE-SET,metacubex-foreign-domain,${target}`),
  )
  if (configured) return configured.name
  return groups.find((group) => group.name === 'PROXY')?.name || groups[0]?.name || ''
}

export function readServiceSelections(config: Config): ServiceSelections {
  const selected: ServiceSelections = {}
  for (const group of config['proxy-groups'] || []) {
    const service = ownedService(group)
    if (!service) continue
    const active = (config.rules || []).some((rule) => {
      const parts = ruleParts(rule)
      const provider = config['rule-providers']?.[parts.payload]
      return (
        parts.type === 'RULE-SET' &&
        parts.target === group.name &&
        provider &&
        ownedService(provider)?.id === service.id
      )
    })
    if (active) selected[service.id] = group.proxies?.[0] || ''
  }
  return selected
}

export function planMetaServices(config: Config, selected: ServiceSelections) {
  const groups: { service: string; name: string; existing?: Group; exit: string }[] = []
  const providers: ServiceProvider[] = []
  const exits = presetExits(config)
  for (const id of Object.keys(selected))
    if (!serviceRules.some((service) => service.id === id)) throw new Error(`未知服务分类：${id}`)
  for (const service of [...serviceRules].sort((a, b) => a.priority - b.priority)) {
    if (!Object.hasOwn(selected, service.id)) continue
    if (!exits.includes(selected[service.id]))
      throw new Error(`${service.name} 的默认出口不存在或会形成循环引用。`)
    const existing = (config['proxy-groups'] || []).filter(
      (g) => ownedService(g)?.id === service.id,
    )
    if (existing.length > 1)
      throw new Error(`${service.name} 有重复的预设组标记，请在 YAML 源码中处理。`)
    const name = existing[0]?.name || service.name
    if (
      (!existing.length &&
        [...(config['proxy-groups'] || []), ...(config.proxies || [])].some(
          (v) => v.name === name,
        )) ||
      (existing[0] && existing[0].type !== 'select')
    )
      throw new Error(
        `「${name}」已被其他节点或代理组使用，或类型已改变，请先改名或在 YAML 源码中处理。`,
      )
    groups.push({ service: service.id, name, existing: existing[0], exit: selected[service.id] })
    for (const spec of serviceProviders(service)) {
      const owned = Object.entries(config['rule-providers'] || {}).filter(
        ([, value]) =>
          ownedService(value)?.id === service.id && value.url === metaRuleURL(spec.file),
      )
      if (owned.length > 1)
        throw new Error(`${service.name} 有重复的预设规则集，请在 YAML 源码中处理。`)
      providers.push({ ...spec, name: owned[0]?.[0] || spec.name })
    }
  }
  const rules = [
    ...providers.filter((p) => p.direct).map((p) => `RULE-SET,${p.name},DIRECT`),
    ...providers
      .filter((p) => !p.direct && p.behavior === 'domain')
      .map((p) => `RULE-SET,${p.name},${groups.find((g) => g.service === p.service)!.name}`),
    ...providers
      .filter((p) => !p.direct && p.behavior === 'ipcidr')
      .map(
        (p) => `RULE-SET,${p.name},${groups.find((g) => g.service === p.service)!.name},no-resolve`,
      ),
  ]
  return { groups, providers, rules }
}

export function metaPresetRules(proxy: string) {
  return [
    ...metaRuleSets.map(
      (entry) =>
        `RULE-SET,${entry.name},${entry.direct ? 'DIRECT' : proxy}${entry.file === 'geoip/private' ? ',no-resolve' : ''}`,
    ),
    `MATCH,${proxy}`,
  ]
}

/** Native providers only. Downloads and scheduling remain Mihomo's responsibility. */
export function applyMetaRulePreset(
  text: string,
  proxy: string,
  selected?: ServiceSelections,
): string {
  const analysis = analyze(text)
  const config = analysis.config
  if (!config) throw new Error('请先修复 YAML 结构。')
  if (!presetProxyGroups(config).some((group) => group.name === proxy))
    throw new Error('请选择配置中已有的国外代理组。')

  const plan = planMetaServices(config, selected ?? readServiceSelections(config))
  const entries = [...metaRuleSets, ...plan.providers]
  // A name collision must not silently repoint a user-defined provider or its consumers.
  for (const entry of entries) {
    const current = config['rule-providers']?.[entry.name]
    if (
      current &&
      (current.type !== 'http' ||
        current.url !== metaRuleURL(entry.file) ||
        ('service' in entry && ownedService(current)?.id !== entry.service))
    )
      throw new Error(`规则集「${entry.name}」已用于其他来源，请先改名。`)
  }

  // The caller commits this string once; any failure leaves the original draft intact.
  const basicRules = metaPresetRules(proxy)
  // Explicit domain/IP DIRECT rules are user exceptions. Preset changes must
  // retain them and keep them ahead of all generated service/country rules.
  const exceptions = (config.rules || []).filter((rule) => directException(rule))
  const rules = [...exceptions, ...basicRules.slice(0, 2), ...plan.rules, ...basicRules.slice(2)]
  const sourceRules = parse(text).get('rules', true)
  if (
    JSON.stringify(config.rules) !== JSON.stringify(rules) &&
    isSeq(sourceRules) &&
    sourceRules.items.some(
      (item) =>
        isAlias(item) ||
        (isNode(item) && (item.comment || item.commentBefore || ('anchor' in item && item.anchor))),
    )
  )
    throw new Error('原规则含有注释或共享引用，请在 YAML 源码中调整，避免把注释对应到不同规则。')
  let next = patchValue(text, ['rules'], rules)
  next = patchValue(next, ['mode'], 'rule')
  for (const group of plan.groups) {
    const proxies = [
      ...new Set([group.exit, ...(group.existing?.proxies || []), proxy, ...presetExits(config)]),
    ]
    const value: Group = {
      ...group.existing,
      name: group.name,
      type: 'select',
      proxies,
      [serviceMarker]: serviceOwner(group.service),
    }
    const providers = Object.keys(config['proxy-providers'] || {})
    if (providers.length || group.existing?.use)
      value.use = [...new Set([...(group.existing?.use || []), ...providers])]
    const index =
      analyze(next).config!['proxy-groups']?.findIndex((g) => g.name === group.name) ?? -1
    if (index >= 0) next = patchValue(next, ['proxy-groups', index], value)
    else {
      const sequence = parse(next).get('proxy-groups', true)
      next =
        isSeq(sequence) && sequence.flow
          ? patchValue(
              next,
              ['proxy-groups'],
              [...(analyze(next).config!['proxy-groups'] || []), value],
            )
          : appendItem(next, 'proxy-groups', value)
    }
  }
  for (const entry of entries) {
    const current = config['rule-providers']?.[entry.name]
    next = saveRuleProvider(next, current ? entry.name : null, entry.name, {
      ...current,
      type: 'http',
      behavior: entry.behavior,
      format: 'mrs',
      url: metaRuleURL(entry.file),
      interval: 86400,
      proxy,
      ...('service' in entry ? { [serviceMarker]: serviceOwner(entry.service) } : {}),
    })
  }
  // Only remove our unused generated items; external references keep them alive.
  for (const [name, provider] of Object.entries(analyze(next).config!['rule-providers'] || {})) {
    if (!ownedService(provider) || plan.providers.some((entry) => entry.name === name)) continue
    if (!ruleProviderReferences(analyze(next).config!, name).length)
      next = removeRuleProvider(next, name)
  }
  let removed = true
  while (removed) {
    removed = false
    const current = analyze(next).config!
    for (const [index, group] of (current['proxy-groups'] || []).entries()) {
      if (!ownedService(group) || plan.groups.some((entry) => entry.name === group.name)) continue
      if (!references(current, group.name).length) {
        next = removeItem(next, 'proxy-groups', index)
        removed = true
        break
      }
    }
  }
  const errors = analyze(next).errors
  if (errors.length) throw new Error(errors.join('；'))
  return next
}
