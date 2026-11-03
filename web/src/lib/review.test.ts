import { describe, expect, it } from 'vitest'
import { analyze, references, rename } from './document'
import { canEditSimpleRule } from './rules'
import { summarizeBlocks } from './blockChanges'

const base = `proxies:\n  - name: src-node\n    type: direct\n  - name: other\n    type: direct\n`
describe('review regressions', () => {
  it('keeps rule parameters and regex commas while renaming targets in sub-rules', () => {
    const text =
      base +
      `rules:\n  - IP-CIDR,10.0.0.0/8,src-node,src,no-resolve\n  - DOMAIN-REGEX,^a{1,3}\\.test$,src-node\n  - SUB-RULE,(NETWORK,TCP),src-node\nsub-rules:\n  src-node:\n    - AND,((NETWORK,TCP),(DOMAIN,example.test)),src-node\n    - MATCH,src-node\n`
    expect(analyze(text).errors).toEqual([])
    expect(references(analyze(text).config!, 'src-node')).toHaveLength(4)
    const changed = rename(text, 'proxies', 0, 'renamed')
    expect(changed).toContain('10.0.0.0/8,renamed,src,no-resolve')
    expect(changed).toContain('SUB-RULE,(NETWORK,TCP),src-node')
    expect(analyze(changed).errors).toEqual([])
    expect(references(analyze(changed).config!, 'src-node')).toEqual([])
  })
  it('does not interpret a target beginning with src as a rule flag', () => {
    expect(analyze(base + 'rules: ["MATCH,src-node"]').errors).toEqual([])
    expect(canEditSimpleRule('IP-CIDR,10.0.0.0/8,src-node,src')).toBe(false)
    expect(canEditSimpleRule('IP-CIDR,10.0.0.0/8,src-node,no-resolve')).toBe(true)
  })
  it('blocks unsafe rename/delete with DNS and tunnel consumers', () => {
    for (const extra of [
      'dns:\n  nameserver: ["https://dns.test/dns-query#src-node"]\n',
      'tunnels: ["tcp,127.0.0.1:1234,example.test:80,src-node"]\n',
    ]) {
      const text = base + extra
      expect(references(analyze(text).config!, 'src-node')).toHaveLength(1)
      expect(() => rename(text, 'proxies', 0, 'renamed')).toThrow('源码')
    }
  })
  it('rejects missing nested rule sets, sub-rule cycles and reserved names', () => {
    expect(
      analyze('rules: ["AND,((RULE-SET,missing),(NETWORK,TCP)),DIRECT"]').errors.join(),
    ).toContain('规则集')
    expect(analyze('sub-rules: {a: ["SUB-RULE,(NETWORK,TCP),a"]}').errors.join()).toContain('循环')
    expect(analyze('proxies: [{name: DIRECT, type: direct}]').errors.join()).toContain('保留')
  })
  it('reports inline root changes without misattributing one line to a block', () => {
    expect(
      summarizeBlocks('{dns: {enable: false}, ipv6: false}', '{dns: {enable: true}, ipv6: false}')
        .changes,
    ).toEqual([{ key: 'yaml', title: 'YAML 配置', added: 1, removed: 1 }])
  })
})
