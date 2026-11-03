import { describe, expect, it } from 'vitest'
import { addRule, analyze, removeRuleProvider, saveRuleProvider } from './document'
import { ruleProviderReferences } from './ruleProviders'
import type { RuleProvider } from './ruleProviders'
import { summarizeChanges } from './changes'

const seed =
  '# untouched\r\nmode: rule\r\nx-private: {preserve: yes}\r\nrules:\r\n  - MATCH,DIRECT\r\n'
const http: RuleProvider = {
  type: 'http',
  behavior: 'domain',
  format: 'yaml',
  url: 'https://example.com/rules.yaml?token=hidden',
  interval: 86400,
}

describe('native rule providers', () => {
  it('adds all source types and removes them without changing unrelated text', () => {
    let next = saveRuleProvider(seed, null, 'HTTP', http)
    next = saveRuleProvider(next, null, 'File', {
      type: 'file',
      behavior: 'ipcidr',
      format: 'mrs',
      path: './rules/ips.mrs',
    })
    next = saveRuleProvider(next, null, 'Inline', {
      type: 'inline',
      behavior: 'classical',
      payload: ['DOMAIN-SUFFIX,example.com'],
    })
    expect(next.startsWith(seed)).toBe(true)
    expect(next.replaceAll('\r\n', '')).not.toContain('\n')
    expect(analyze(next).errors).toEqual([])
    expect(Object.keys(analyze(next).config!['rule-providers']!)).toHaveLength(3)
    for (const name of ['HTTP', 'File', 'Inline']) next = removeRuleProvider(next, name)
    expect(next).toBe(seed)
  })
  it('changes only selected fields, retaining headers, unknown fields and comments', () => {
    const source =
      seed +
      'rule-providers:\r\n  A:\r\n    type: http\r\n    behavior: domain\r\n    url: "https://old.example.com" # keep\r\n    interval: 60\r\n    header: {Authorization: [private]}\r\n    x-keep: true\r\n'
    const value = analyze(source).config!['rule-providers']!.A
    const next = saveRuleProvider(source, 'A', 'A', {
      ...value,
      url: 'https://new.example.com',
      interval: 120,
    })
    expect(next).toBe(
      source
        .replace('https://old.example.com', 'https://new.example.com')
        .replace('interval: 60', 'interval: 120'),
    )
    expect(saveRuleProvider(source, 'A', 'A', value)).toBe(source)
  })
  it('inserts RULE-SET before MATCH, renames ordinary references and prevents deletion while used', () => {
    let next = saveRuleProvider(seed, null, 'A', http)
    next = addRule(next, 'RULE-SET,A,DIRECT')
    expect(analyze(next).config!.rules).toEqual(['RULE-SET,A,DIRECT', 'MATCH,DIRECT'])
    expect(() => removeRuleProvider(next, 'A')).toThrow('仍被')
    next = saveRuleProvider(next, 'A', 'B', http)
    expect(analyze(next).config!.rules).toEqual(['RULE-SET,B,DIRECT', 'MATCH,DIRECT'])
    expect(analyze(next).errors).toEqual([])
  })
  it('refuses destructive edits to advanced references, aliased objects and comment-bearing deletions', () => {
    const base = saveRuleProvider(seed, null, 'A', http)
    for (const extra of [
      'dns:\n  nameserver-policy:\n    "rule-set:A": [1.1.1.1]\n',
      'sub-rules:\n  test: ["AND,((RULE-SET,A),(NETWORK,UDP)),DIRECT"]\n',
      'tun:\n  route-address-set: [A]\n',
    ]) {
      const source = base + extra
      expect(ruleProviderReferences(analyze(source).config!, 'A')).toHaveLength(1)
      expect(() => removeRuleProvider(source, 'A')).toThrow('仍被')
      expect(() => saveRuleProvider(source, 'A', 'B', http)).toThrow('源码')
    }
    const shared =
      'defs: &p {type: http, behavior: domain, url: https://example.com}\nrule-providers: {A: *p}\n'
    expect(() => saveRuleProvider(shared, 'A', 'B', http)).toThrow('共享')
    expect(() =>
      removeRuleProvider(
        'rule-providers:\n  # keep me\n  A: {type: inline, behavior: domain, payload: []}\n',
        'A',
      ),
    ).toThrow('注释')
  })
  it('renames normal sub-rule references and preserves names that merely share a prefix', () => {
    let source = saveRuleProvider(seed, null, 'A', http)
    source = saveRuleProvider(source, null, 'AB', http)
    source += 'sub-rules:\n  sample: ["RULE-SET,A,DIRECT,no-resolve", "RULE-SET,AB,DIRECT"]\n'
    const next = saveRuleProvider(source, 'A', 'B', http)
    expect(next).toContain('RULE-SET,B,DIRECT,no-resolve')
    expect(next).toContain('RULE-SET,AB,DIRECT')
  })
  it('keeps omitted defaults absent and supports empty maps and optional-field removal', () => {
    let next = saveRuleProvider('mode: rule\nrule-providers: {}\n...\n', null, 'A', {
      ...http,
      format: undefined,
      interval: undefined,
    })
    next = saveRuleProvider(next, null, 'B', {
      type: 'inline',
      behavior: 'domain',
      payload: ['+.example.com'],
    })
    expect(next.endsWith('...\n')).toBe(true)
    expect(analyze(next).config!['rule-providers']!.A).not.toHaveProperty('interval')
    expect(analyze(next).config!['rule-providers']!.A).not.toHaveProperty('format')
    const withPath = saveRuleProvider(seed, null, 'A', { ...http, path: './rules/a.yaml' })
    const cleared = saveRuleProvider(withPath, 'A', 'A', {
      ...http,
      interval: undefined,
      format: undefined,
    })
    expect(analyze(cleared).config!['rule-providers']!.A).not.toHaveProperty('path')
    expect(analyze(cleared).config!['rule-providers']!.A).not.toHaveProperty('interval')
  })
  it('rejects invalid names, duplicate paths, source URLs and incompatible formats', () => {
    const source = saveRuleProvider(seed, null, 'A', { ...http, path: './rules/a.yaml' })
    for (const name of ['', 'A', 'x,y', 'x(y)'])
      expect(() => saveRuleProvider(source, null, name, http)).toThrow('名称')
    for (const value of [
      { ...http, format: 'mrs', behavior: 'classical' },
      { ...http, interval: -1 },
      { ...http, url: 'file:///tmp/a' },
      { ...http, url: 'https://user:pass@example.com' },
      { ...http, path: 'rules/a.yaml' },
      { type: 'file', behavior: 'domain' },
    ] as RuleProvider[])
      expect(() => saveRuleProvider(source, null, 'B', value)).toThrow()
    expect(analyze('rules: ["RULE-SET,missing,DIRECT"]\n').errors.join()).toContain(
      '不存在的规则集',
    )
  })
  it('reports URL, interval, format, rename and deletion in Chinese without leaking tokens', () => {
    const added = saveRuleProvider(seed, null, 'A', http)
    const summary = summarizeChanges(seed, added)
    expect(summary.changes).toHaveLength(1)
    expect(summary.changes[0]).toMatchObject({ kind: 'added', title: '规则集「A」' })
    expect(summary.changes[0].details).toContain('更新间隔：86400 秒')
    expect(JSON.stringify(summary)).not.toContain('hidden')
    const renamed = saveRuleProvider(added, 'A', 'B', http)
    expect(summarizeChanges(added, renamed).changes[0].title).toBe('规则集「A」→「B」')
    const changed = saveRuleProvider(renamed, 'B', 'B', {
      ...http,
      url: 'https://example.com/new?token=secret',
      interval: 3600,
      format: 'mrs',
    })
    const details = summarizeChanges(renamed, changed).changes[0].details.join(' ')
    expect(details).toContain('86400 秒 → 3600 秒')
    expect(details).toContain('YAML → MRS')
    expect(details).toContain('来源地址已修改')
    expect(details).not.toContain('secret')
    expect(summarizeChanges(renamed, removeRuleProvider(renamed, 'B')).changes[0]).toMatchObject({
      kind: 'removed',
      title: '规则集「B」',
    })
  })
  it('detects normalized duplicate paths and safely reports deeply nested references', () => {
    const source = saveRuleProvider(seed, null, 'A', { ...http, path: './rules/a.yaml' })
    expect(() =>
      saveRuleProvider(source, null, 'B', { ...http, path: 'rules/tmp/../a.yaml' }),
    ).toThrow('相同文件路径')
    let nested: unknown = 'RULE-SET,A,DIRECT'
    for (let i = 0; i < 70; i++) nested = { nested }
    expect(ruleProviderReferences({ nested }, 'A')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ editable: false, label: expect.stringContaining('深层配置') }),
      ]),
    )
  })
})
