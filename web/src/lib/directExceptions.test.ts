import { describe, expect, it } from 'vitest'
import { analyze } from './document'
import {
  deleteDirectException,
  directException,
  makeDirectException,
  saveDirectException,
} from './directExceptions'
import { applyMetaRulePreset } from './rulePresets'
import { summarizeBlocks } from './blockChanges'

const base =
  'mode: rule\nproxy-groups:\n  - name: PROXY\n    type: select\n    proxies: [DIRECT]\nrules:\n  - MATCH,PROXY\ndns: {enable: true} # keep\n'
describe('manual direct exceptions', () => {
  it('generates native domain and IP rules with explicit matching semantics', () => {
    expect(makeDirectException('DOMAIN-SUFFIX', '*.Home.Example.com')).toBe(
      'DOMAIN-SUFFIX,home.example.com,DIRECT',
    )
    expect(makeDirectException('DOMAIN', 'Only.Example.com.')).toBe(
      'DOMAIN,only.example.com,DIRECT',
    )
    expect(makeDirectException('IP-CIDR', '192.0.2.20')).toBe(
      'IP-CIDR,192.0.2.20/32,DIRECT',
    )
    expect(makeDirectException('IP-CIDR', '192.0.2.0/24', true)).toBe(
      'IP-CIDR,192.0.2.0/24,DIRECT,no-resolve',
    )
    expect(makeDirectException('IP-CIDR6', '2001:db8::1')).toBe('IP-CIDR6,2001:db8::1/128,DIRECT')
    expect(makeDirectException('IP-CIDR6', '2001:db8::/32')).toBe('IP-CIDR6,2001:db8::/32,DIRECT')
    expect(directException('IP-CIDR,192.168.0.0/16,DIRECT,src')).toBeNull()
    expect(directException('RULE-SET,cn,DIRECT')).toBeNull()
  })
  it('rejects URLs, target injection, invalid addresses and prefix lengths', () => {
    for (const input of [
      'https://example.com',
      'a.com,PROXY',
      'a.com:443',
      'a.*.com',
      'a.com/x',
      '192.168.1.1',
    ])
      expect(() => makeDirectException('DOMAIN-SUFFIX', input)).toThrow()
    for (const input of ['256.1.1.1', '1.2.3', '1.2.3.4/33', '1.2.3.4/-1', '1.2.3.4/', '01.2.3.4'])
      expect(() => makeDirectException('IP-CIDR', input)).toThrow()
    for (const input of ['2001:::1', '::1/129', 'fe80::1%eth0', '[::1]', '1.2.3.4'])
      expect(() => makeDirectException('IP-CIDR6', input)).toThrow()
  })
  it('supports add/edit/delete, keeps other blocks untouched and reports rules only', () => {
    const first = makeDirectException('DOMAIN-SUFFIX', 'home.example.com')
    const added = saveDirectException(base, null, first)
    expect(analyze(added).config?.rules).toEqual([first, 'MATCH,PROXY'])
    expect(added).toContain('dns: {enable: true} # keep\n')
    expect(summarizeBlocks(base, added).changes.map((c) => c.key)).toEqual(['rules'])
    const second = makeDirectException('IP-CIDR', '192.0.2.1')
    const edited = saveDirectException(added, { index: 0, value: first }, second)
    expect(analyze(edited).config?.rules?.[0]).toBe(second)
    expect(deleteDirectException(edited, 0, second)).toBe(base)
    expect(() => deleteDirectException(edited, 0, first)).toThrow('已经变化')
    expect(() => saveDirectException(added, null, first)).toThrow('已存在')
  })
  it('preserves exceptions ahead of Steam and other generated rules when changing presets', () => {
    const rule = makeDirectException('DOMAIN-SUFFIX', 'home.example.com')
    const added = saveDirectException(base, null, rule)
    const withSteam = applyMetaRulePreset(added, 'PROXY', { steam: 'DIRECT' })
    expect(analyze(withSteam).config?.rules?.[0]).toBe(rule)
    const withMicrosoft = applyMetaRulePreset(withSteam, 'PROXY', { microsoft: 'DIRECT' })
    expect(analyze(withMicrosoft).config?.rules?.[0]).toBe(rule)
    expect(analyze(withMicrosoft).config?.rules?.filter((r) => r === rule)).toHaveLength(1)
    expect(applyMetaRulePreset(withMicrosoft, 'PROXY', { microsoft: 'DIRECT' })).toBe(withMicrosoft)
  })
  it('handles inline/empty rule lists and refuses shared aliases', () => {
    const rule = makeDirectException('DOMAIN', 'example.com')
    expect(
      analyze(saveDirectException('rules: ["MATCH,DIRECT"]\n', null, rule)).config?.rules,
    ).toEqual([rule, 'MATCH,DIRECT'])
    const only = saveDirectException('rules: []\n', null, rule)
    expect(analyze(deleteDirectException(only, 0, rule)).config?.rules).toEqual([])
    expect(() =>
      saveDirectException('base: &shared ["MATCH,DIRECT"]\nrules: *shared\n', null, rule),
    ).toThrow()
  })
})
