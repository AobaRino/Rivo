import { describe, expect, it } from 'vitest'
import { analyze, patchValue, saveRuleProvider } from './document'
import { summarizeBlocks } from './blockChanges'
import {
  applyMetaRulePreset,
  defaultPresetProxy,
  metaRuleSets,
  presetProxyGroups,
} from './rulePresets'

const base = `# local configuration\r\nmode: rule\r\ndns: {nameserver: [223.5.5.5]} # keep DNS\r\nx-private: {keep: true}\r\nproxy-groups:\r\n  - name: PROXY\r\n    type: select\r\n    proxies: [DIRECT]\r\n  - name: AUTO\r\n    type: select\r\n    proxies: [DIRECT]\r\nrules:\r\n  - MATCH,DIRECT\r\n`

describe('MetaCubeX native rule preset', () => {
  it('orders domain rules before country IP resolution and ends in the selected proxy', () => {
    const next = applyMetaRulePreset(base, 'PROXY')
    const { config, errors } = analyze(next)
    expect(errors).toEqual([])
    expect(config!.rules).toEqual([
      'RULE-SET,metacubex-private-domain,DIRECT',
      'RULE-SET,metacubex-private-ip,DIRECT,no-resolve',
      'RULE-SET,metacubex-cn-domain,DIRECT',
      'RULE-SET,metacubex-foreign-domain,PROXY',
      'RULE-SET,metacubex-cn-ip,DIRECT',
      'MATCH,PROXY',
    ])
    expect(Object.values(config!['rule-providers']!)).toHaveLength(5)
    for (const provider of Object.values(config!['rule-providers']!)) {
      expect(provider).toMatchObject({
        type: 'http',
        format: 'mrs',
        interval: 86400,
        proxy: 'PROXY',
      })
      expect(provider.url).toMatch(
        /^https:\/\/raw\.githubusercontent\.com\/MetaCubeX\/meta-rules-dat\/meta\/geo\/(geosite|geoip)\/.+\.mrs$/,
      )
      expect(provider.behavior).toBe(provider.url!.includes('/geosite/') ? 'domain' : 'ipcidr')
    }
    expect(next.split('rules:')[0]).toBe(base.split('rules:')[0])
    expect(next.replaceAll('\r\n', '')).not.toContain('\n')
    expect(
      summarizeBlocks(base, next)
        .changes.map((change) => change.key)
        .sort(),
    ).toEqual(['rule-providers', 'rules'])
  })

  it('is idempotent and can change groups without duplicating providers or rules', () => {
    const first = applyMetaRulePreset(base, 'PROXY')
    expect(applyMetaRulePreset(first, 'PROXY')).toBe(first)
    const changed = applyMetaRulePreset(first, 'AUTO')
    expect(defaultPresetProxy(analyze(changed).config!)).toBe('AUTO')
    expect(analyze(changed).errors).toEqual([])
    expect(analyze(changed).config!.rules!.at(-1)).toBe('MATCH,AUTO')
    expect(Object.keys(analyze(changed).config!['rule-providers']!)).toHaveLength(5)
    expect(changed).not.toContain('metacubex-foreign-domain,PROXY')
    expect(applyMetaRulePreset(changed, 'AUTO')).toBe(changed)
  })

  it('preserves other providers, sub-rules, DNS, comments and unknown fields', () => {
    let source = saveRuleProvider(base, null, 'custom', {
      type: 'inline',
      behavior: 'domain',
      payload: ['+.example.com'],
    })
    source += 'sub-rules:\r\n  custom: ["RULE-SET,custom,DIRECT"]\r\n'
    const next = applyMetaRulePreset(source, 'PROXY')
    expect(next).toContain('dns: {nameserver: [223.5.5.5]} # keep DNS\r\n')
    expect(next).toContain('x-private: {keep: true}\r\n')
    expect(next).toContain('sub-rules:\r\n  custom: ["RULE-SET,custom,DIRECT"]\r\n')
    expect(analyze(next).config!['rule-providers']!.custom).toEqual(
      analyze(source).config!['rule-providers']!.custom,
    )
    const modified = patchValue(next, ['rule-providers', metaRuleSets[0].name, 'x-keep'], true)
    const reapplied = applyMetaRulePreset(modified, 'AUTO')
    expect(analyze(reapplied).config!['rule-providers']![metaRuleSets[0].name]['x-keep']).toBe(true)
  })

  it('does not overwrite a provider with the same name but another source', () => {
    const source = saveRuleProvider(base, null, metaRuleSets[0].name, {
      type: 'http',
      behavior: 'domain',
      url: 'https://example.com/private.yaml',
    })
    expect(() => applyMetaRulePreset(source, 'PROXY')).toThrow('已用于其他来源')
    expect(source).toContain('https://example.com/private.yaml')
  })

  it('rejects missing or malformed proxy targets and unsafe shared source edits', () => {
    for (const proxy of ['DIRECT', 'missing', 'PROXY,REJECT', 'PROXY\n'])
      expect(() => applyMetaRulePreset(base, proxy)).toThrow('国外代理组')
    expect(defaultPresetProxy({})).toBe('')
    expect(presetProxyGroups({ 'proxy-groups': [{ name: 'bad,name', type: 'select' }] })).toEqual(
      [],
    )
    expect(() =>
      applyMetaRulePreset(
        base.replace('  - MATCH,DIRECT', '  - MATCH,DIRECT # important'),
        'PROXY',
      ),
    ).toThrow('注释')
    expect(() =>
      applyMetaRulePreset(base.replace('rules:\r\n', 'rules: &shared\r\n'), 'PROXY'),
    ).toThrow('引用')
    expect(() => applyMetaRulePreset('mode: [', 'PROXY')).toThrow('YAML')
  })

  it('sets the startup mode to rule and supports a new rules block', () => {
    const source = base
      .replace('mode: rule', 'mode: global')
      .replace('rules:\r\n  - MATCH,DIRECT\r\n', '')
    const next = applyMetaRulePreset(source, 'PROXY')
    expect(analyze(next).config!.mode).toBe('rule')
    expect(analyze(next).errors).toEqual([])
    expect(
      summarizeBlocks(source, next)
        .changes.map((change) => change.key)
        .sort(),
    ).toEqual(['general', 'rule-providers', 'rules'])
  })

  it('does not attach old comments to new rules when replacing an equally sized list', () => {
    const source = base.replace(
      '  - MATCH,DIRECT',
      [
        '  - DOMAIN,first.example,DIRECT # keep with first.example',
        '  - DOMAIN,second.example,DIRECT',
        '  - DOMAIN,third.example,DIRECT',
        '  - DOMAIN,fourth.example,DIRECT',
        '  - DOMAIN,fifth.example,DIRECT',
        '  - MATCH,DIRECT',
      ].join('\r\n'),
    )
    expect(() => applyMetaRulePreset(source, 'PROXY')).toThrow('注释')
  })
})
