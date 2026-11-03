import { describe, expect, it } from 'vitest'
import { analyze, appendItem, patchValue, rename, saveRuleProvider } from './document'
import { summarizeBlocks } from './blockChanges'
import {
  applyMetaRulePreset,
  planMetaServices,
  presetExits,
  presetProxyGroups,
  readServiceSelections,
} from './rulePresets'
import { serviceMarker, serviceOwner, serviceRules } from './serviceRules'
import type { ServiceSelections } from './serviceRules'

const seed = `# keep this header\nmode: rule\ndns: {nameserver: [223.5.5.5]} # keep DNS\nproxies:\n  - name: selfhost\n    type: socks5\n    server: example.com\n    port: 1080\nproxy-providers:\n  subscription:\n    type: http\n    url: https://example.com/sub\nproxy-groups:\n  - name: PROXY\n    type: select\n    proxies: [selfhost]\n    use: [subscription]\n  - name: AUTO\n    type: select\n    proxies: [selfhost]\nrules:\n  - MATCH,PROXY\nx-preserved: true\n`
const selected = { steam: 'PROXY', microsoft: 'DIRECT', onedrive: 'selfhost', openai: 'AUTO' }

describe('service routing presets', () => {
  it('creates standard select groups with static and subscription nodes, retaining defaults across reopening', () => {
    const next = applyMetaRulePreset(seed, 'PROXY', selected)
    const { config, errors } = analyze(next)
    expect(errors).toEqual([])
    expect(readServiceSelections(config!)).toEqual(selected)
    expect(config!['proxy-groups']!.find((g) => g.name === 'OneDrive')).toMatchObject({
      type: 'select',
      proxies: ['selfhost', 'PROXY', 'DIRECT', 'AUTO'],
      use: ['subscription'],
    })
    expect(next).toContain('dns: {nameserver: [223.5.5.5]} # keep DNS\n')
    expect(next).toContain('x-preserved: true\n')
    expect(applyMetaRulePreset(next, 'PROXY', selected)).toBe(next)
    expect(applyMetaRulePreset(next, 'PROXY')).toBe(next)
    expect(
      summarizeBlocks(seed, next)
        .changes.map((v) => v.key)
        .sort(),
    ).toEqual(['proxy-groups', 'rule-providers', 'rules'])
  })

  it('orders domestic exceptions and narrow services ahead of parent categories and base rules', () => {
    const all = Object.fromEntries(serviceRules.map((s) => [s.id, s.direct ? 'DIRECT' : 'PROXY']))
    const next = applyMetaRulePreset(seed, 'PROXY', all)
    const { config, errors } = analyze(next)
    expect(errors).toEqual([])
    expect(readServiceSelections(config!)).toEqual(all)
    expect(config!['proxy-groups']).toHaveLength(2 + serviceRules.length)
    const rules = config!.rules!
    const index = (fragment: string) => {
      const i = rules.findIndex((rule) => rule.startsWith('RULE-SET,' + fragment + ','))
      expect(i, fragment).toBeGreaterThanOrEqual(0)
      return i
    }
    for (const [early, late] of [
      ['metacubex-direct-steam', 'metacubex-domain-steam'],
      ['metacubex-direct-microsoft', 'metacubex-domain-onedrive'],
      ['metacubex-domain-onedrive', 'metacubex-domain-microsoft'],
      ['metacubex-domain-copilot', 'metacubex-domain-microsoft'],
      ['metacubex-domain-gemini', 'metacubex-domain-google'],
      ['metacubex-domain-youtube', 'metacubex-domain-google'],
      ['metacubex-domain-appletv', 'metacubex-domain-apple'],
      ['metacubex-domain-github', 'metacubex-domain-developer'],
      ['metacubex-domain-steam', 'metacubex-domain-games'],
      ['metacubex-domain-google', 'metacubex-cn-domain'],
      ['metacubex-ip-telegram', 'metacubex-foreign-domain'],
    ])
      expect(index(early)).toBeLessThan(index(late))
    expect(rules.at(-1)).toBe('MATCH,PROXY')
    expect(rules).toContain('RULE-SET,metacubex-cn-ip,DIRECT')
    for (const provider of Object.values(config!['rule-providers']!)) {
      expect(provider).toMatchObject({
        type: 'http',
        format: 'mrs',
        interval: 86400,
        proxy: 'PROXY',
      })
      expect(provider.url).toContain(
        'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/',
      )
    }
  })

  it('changes the default exit without replacing the group, duplicating rules or losing custom fields', () => {
    let source = applyMetaRulePreset(seed, 'PROXY', selected)
    const index = analyze(source).config!['proxy-groups']!.findIndex((g) => g.name === 'Steam')
    source = patchValue(source, ['proxy-groups', index, 'x-custom'], { keep: true })
    const next = applyMetaRulePreset(source, 'PROXY', { ...selected, steam: 'AUTO' })
    const group = analyze(next).config!['proxy-groups']![index]
    expect(group.proxies![0]).toBe('AUTO')
    expect(new Set(group.proxies).size).toBe(group.proxies!.length)
    expect(group['x-custom']).toEqual({ keep: true })
    expect(analyze(source).config!.rules).toEqual(analyze(next).config!.rules)
    expect(summarizeBlocks(source, next).changes.map((v) => v.key)).toEqual(['proxy-groups'])
  })

  it('deselects and removes unused generated resources while preserving other providers', () => {
    let source = applyMetaRulePreset(seed, 'PROXY', selected)
    source = saveRuleProvider(source, null, 'unrelated', {
      type: 'inline',
      behavior: 'domain',
      payload: ['+.example.com'],
    })
    const next = applyMetaRulePreset(source, 'PROXY', { microsoft: 'DIRECT' })
    const { config, errors } = analyze(next)
    expect(errors).toEqual([])
    expect(readServiceSelections(config!)).toEqual({ microsoft: 'DIRECT' })
    expect(config!['proxy-groups']!.some((g) => g.name === 'Steam')).toBe(false)
    expect(config!['rule-providers']).not.toHaveProperty('metacubex-domain-steam')
    expect(config!['rule-providers']).toHaveProperty('unrelated')
    const cleared = analyze(applyMetaRulePreset(next, 'PROXY', {}))
    expect(cleared.errors).toEqual([])
    expect(cleared.config!['proxy-groups']).toHaveLength(2)
    expect(Object.keys(cleared.config!['rule-providers']!)).toHaveLength(6)
    expect(cleared.config!.rules).toHaveLength(6)
  })

  it('keeps deselected groups and rule providers used by other configuration', () => {
    let source = applyMetaRulePreset(seed, 'PROXY', { steam: 'PROXY' })
    source = appendItem(source, 'proxy-groups', {
      name: 'custom',
      type: 'select',
      proxies: ['Steam'],
    })
    source += 'sub-rules:\n  keep: ["RULE-SET,metacubex-domain-steam,Steam"]\n'
    const next = applyMetaRulePreset(source, 'PROXY', {})
    expect(analyze(next).errors).toEqual([])
    expect(analyze(next).config!['proxy-groups']!.some((g) => g.name === 'Steam')).toBe(true)
    expect(analyze(next).config!['rule-providers']).toHaveProperty('metacubex-domain-steam')
    expect(readServiceSelections(analyze(next).config!)).toEqual({})
  })

  it('follows renamed generated groups and providers on reopening and regeneration', () => {
    let source = applyMetaRulePreset(seed, 'PROXY', { steam: 'AUTO' })
    const index = analyze(source).config!['proxy-groups']!.findIndex((g) => g.name === 'Steam')
    source = rename(source, 'proxy-groups', index, '我的 Steam')
    source = saveRuleProvider(
      source,
      'metacubex-domain-steam',
      '我的 Steam 规则',
      analyze(source).config!['rule-providers']!['metacubex-domain-steam'],
    )
    expect(readServiceSelections(analyze(source).config!)).toEqual({ steam: 'AUTO' })
    expect(applyMetaRulePreset(source, 'PROXY', { steam: 'AUTO' })).toBe(source)
  })

  it('refuses collisions, unknown selections, missing defaults and cyclic exits', () => {
    const collision = appendItem(seed, 'proxy-groups', {
      name: 'Steam',
      type: 'select',
      proxies: ['PROXY'],
    })
    expect(() => applyMetaRulePreset(collision, 'PROXY', { steam: 'PROXY' })).toThrow('已被其他')
    const providerCollision = saveRuleProvider(seed, null, 'metacubex-domain-steam', {
      type: 'http',
      behavior: 'domain',
      url: 'https://example.com/rules',
    })
    expect(() => applyMetaRulePreset(providerCollision, 'PROXY', { steam: 'PROXY' })).toThrow(
      '已用于其他来源',
    )
    const invalidSelections: ServiceSelections[] = [
      { unknown: 'PROXY' },
      { steam: 'missing' },
      { steam: 'Steam' },
    ]
    for (const value of invalidSelections)
      expect(() => applyMetaRulePreset(seed, 'PROXY', value)).toThrow()
    let source = applyMetaRulePreset(seed, 'PROXY', { steam: 'PROXY' })
    source = appendItem(source, 'proxy-groups', {
      name: 'indirect',
      type: 'select',
      proxies: ['Steam'],
    })
    source = appendItem(source, 'proxy-groups', {
      name: 'indirect2',
      type: 'select',
      proxies: ['indirect'],
    })
    const config = analyze(source).config!
    expect(presetExits(config)).not.toContain('Steam')
    expect(presetProxyGroups(config).map((g) => g.name)).not.toContain('indirect2')
    expect(() => planMetaServices(config, { steam: 'indirect2' })).toThrow('循环')
    const duplicated = appendItem(source, 'proxy-groups', {
      name: 'duplicate',
      type: 'select',
      proxies: ['PROXY'],
      [serviceMarker]: serviceOwner('steam'),
    })
    expect(() => applyMetaRulePreset(duplicated, 'PROXY', { steam: 'PROXY' })).toThrow('重复')
  })
})
