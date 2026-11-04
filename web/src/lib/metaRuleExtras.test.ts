import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import type { Config } from './document'
import {
  extraMarker,
  extraProviderName,
  extraRuleURL,
  isMetaRuleExtra,
  needsMetaRuleExtras,
  upgradeMetaRuleExtras,
} from './metaRuleExtras'

const upstream = 'https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat/meta/geo/'
const source = `# keep this header
mode: global # do not switch modes
profile: {store-selected: true}
proxy-groups:
  - name: 当前出口
    type: select
    proxies: [第二个节点, DIRECT, 第一个节点]
    x-manager-order: [第二个节点, 第一个节点]
rule-providers:
  我的微软:
    type: http
    behavior: domain
    format: mrs
    url: ${upstream}geosite/microsoft.mrs # original URL
    interval: 0 # disabled refresh is intentional
    path: ./rules/microsoft-custom.mrs
    proxy: 当前出口
    header: {User-Agent: [my-agent], Authorization: [private-value]}
    x-manager-service: metacubex:microsoft
  国内:
    type: http
    behavior: domain
    format: mrs
    url: ${upstream}geosite/cn.mrs
rules:
  - DOMAIN-SUFFIX,home.example,DIRECT # explicit exception
  - 'RULE-SET,我的微软,当前出口,no-resolve' # route comment
  # CN should keep this comment
  - RULE-SET,国内,DIRECT
  - MATCH,当前出口
dns:
  nameserver-policy:
    'rule-set:国内': [223.5.5.5]
geox-url: {geosite: https://example.com/custom-geosite.dat}
sub-rules:
  nested:
    - RULE-SET,我的微软,DIRECT,src,no-resolve # keep options
    - 'AND,((RULE-SET,我的微软),(NETWORK,TCP)),DIRECT'
...
`

function config(text: string): Config {
  const document = parseDocument(text, { merge: true })
  expect(document.errors).toEqual([])
  return document.toJS() as Config
}

function minimal(name = 'a', file = 'geosite/openai', rest = '') {
  return `rule-providers:
  ${name}:
    type: http
    behavior: domain
    format: mrs
    url: ${upstream}${file}.mrs
${rest}rules:
  - RULE-SET,${name},DIRECT
  - MATCH,DIRECT
`
}

describe('Meta rule keyword and regex companions', () => {
  it('uses stable companion names and the generated HTTP source', () => {
    expect(extraProviderName('自定义名称')).toBe('自定义名称-extra')
    expect(extraRuleURL('geosite/steam@cn')).toBe(
      'https://raw.githubusercontent.com/AobaRino/Rivo/rules/geosite/steam@cn.list',
    )
  })

  it('accepts parentheses in ordinary provider and outbound names', () => {
    const input = minimal('service(US)').replaceAll(',DIRECT', ',PROXY (US)')
    const result = upgradeMetaRuleExtras(input)
    expect(config(result).rules).toEqual([
      'RULE-SET,service(US),PROXY (US)',
      'RULE-SET,service(US)-extra,PROXY (US)',
      'MATCH,PROXY (US)',
    ])
    expect(upgradeMetaRuleExtras(result)).toBe(result)
  })

  it('identifies owned extras by strict provider type and an allowlisted exact URL', () => {
    const provider = config(upgradeMetaRuleExtras(minimal()))['rule-providers']!['a-extra']
    expect(isMetaRuleExtra(provider)).toBe(true)
    expect(isMetaRuleExtra({ ...provider, [extraMarker]: undefined })).toBe(true)
    for (const override of [
      { type: 'file' as const },
      { behavior: 'domain' as const },
      { format: 'yaml' as const },
      { url: extraRuleURL('geosite/category-ads-all') },
      { url: `${provider.url}?custom=true` },
      { url: 'https://example.com/custom.list', [extraMarker]: 'a' },
    ])
      expect(isMetaRuleExtra({ ...provider, ...override })).toBe(false)
  })

  it('only inserts providers and matching routing rules, preserving every original line', () => {
    const before = config(source)
    const next = upgradeMetaRuleExtras(source)
    const after = config(next)
    const lines = next.split('\n')
    let position = 0
    for (const line of source.split('\n')) {
      const found = lines.indexOf(line, position)
      expect(found, `original line: ${line}`).toBeGreaterThanOrEqual(position)
      position = found + 1
    }
    expect(after.rules).toEqual([
      'DOMAIN-SUFFIX,home.example,DIRECT',
      'RULE-SET,我的微软,当前出口,no-resolve',
      'RULE-SET,我的微软-extra,当前出口,no-resolve',
      'RULE-SET,国内,DIRECT',
      'RULE-SET,国内-extra,DIRECT',
      'MATCH,当前出口',
    ])
    expect(after['sub-rules']!.nested).toEqual([
      'RULE-SET,我的微软,DIRECT,src,no-resolve',
      'RULE-SET,我的微软-extra,DIRECT,src,no-resolve',
      'AND,((RULE-SET,我的微软),(NETWORK,TCP)),DIRECT',
    ])
    for (const key of ['mode', 'profile', 'proxy-groups', 'dns', 'geox-url'])
      expect(after[key]).toEqual(before[key])
    for (const name of ['我的微软', '国内'])
      expect(after['rule-providers']![name]).toEqual(before['rule-providers']![name])
    expect(next.endsWith('...\n')).toBe(true)
    expect(upgradeMetaRuleExtras(next)).toBe(next)
    expect(needsMetaRuleExtras(before)).toBe(true)
    expect(needsMetaRuleExtras(after)).toBe(false)
  })

  it('inherits download settings and ownership but never reuses the MRS cache path', () => {
    const providers = config(upgradeMetaRuleExtras(source))['rule-providers']!
    expect(providers['我的微软-extra']).toEqual({
      type: 'http',
      behavior: 'classical',
      format: 'text',
      url: extraRuleURL('geosite/microsoft'),
      interval: 0,
      proxy: '当前出口',
      header: { 'User-Agent': ['my-agent'], Authorization: ['private-value'] },
      'x-manager-service': 'metacubex:microsoft',
      [extraMarker]: '我的微软',
    })
    expect(providers['国内-extra'].interval).toBe(86400)
    expect(providers['国内-extra']).not.toHaveProperty('path')
    expect(providers['国内-extra']).not.toHaveProperty('proxy')
    const withInterval = minimal().replace('    format: mrs', '    interval: 7200\n    format: mrs')
    expect(config(upgradeMetaRuleExtras(withInterval))['rule-providers']!['a-extra'].interval).toBe(
      7200,
    )
  })

  it('recognizes arbitrary source names and renamed companions by their exact URL', () => {
    const previous = upgradeMetaRuleExtras(minimal('renamed-source'))
      .replaceAll('renamed-source-extra', 'renamed-extra')
      .replaceAll('RULE-SET,renamed-source,', 'RULE-SET,new-source,')
      .replace('  renamed-source:', '  new-source:')
      .replace('interval: 86400', 'interval: 1234')
    expect(upgradeMetaRuleExtras(previous)).toBe(previous)
    expect(needsMetaRuleExtras(config(previous))).toBe(false)
    const missingReference = previous.replace('  - "RULE-SET,renamed-extra,DIRECT"\n', '')
    const fixed = upgradeMetaRuleExtras(missingReference)
    expect(config(fixed).rules).toContain('RULE-SET,renamed-extra,DIRECT')
    expect(config(fixed)['rule-providers']!['renamed-extra'].interval).toBe(1234)
    expect(config(fixed)['rule-providers']).not.toHaveProperty('new-source-extra')
  })

  it('retains an existing marked companion and its custom update and cache settings', () => {
    const previous = minimal(
      'a',
      'geosite/openai',
      `  custom:
    type: http
    behavior: classical
    format: text
    url: ${extraRuleURL('geosite/openai')}
    interval: 77
    path: ./custom/extra.list
    ${extraMarker}: a
`,
    )
    const after = upgradeMetaRuleExtras(previous)
    expect(config(after)['rule-providers']!.custom).toEqual(
      config(previous)['rule-providers']!.custom,
    )
    expect(config(after).rules).toContain('RULE-SET,custom,DIRECT')
    expect(config(after)['rule-providers']).not.toHaveProperty('a-extra')
    expect(upgradeMetaRuleExtras(after)).toBe(after)
    expect(() =>
      upgradeMetaRuleExtras(
        previous.replace(extraRuleURL('geosite/openai'), 'https://example.com/other.list'),
      ),
    ).toThrow('来源或归属')
  })

  it('fails closed on an occupied generated name, ambiguous matches or changed behavior', () => {
    const occupied = minimal(
      'a',
      'geosite/openai',
      `  a-extra:
    type: inline
    behavior: domain
    payload: []
`,
    )
    expect(() => upgradeMetaRuleExtras(occupied)).toThrow('已被占用')
    const ambiguous = minimal(
      'a',
      'geosite/openai',
      `  extra-one:
    type: http
    behavior: classical
    format: text
    url: ${extraRuleURL('geosite/openai')}
  extra-two:
    type: inline
    behavior: classical
    payload: []
    ${extraMarker}: a
`,
    )
    expect(() => upgradeMetaRuleExtras(ambiguous)).toThrow('多个补充')
    expect(() =>
      upgradeMetaRuleExtras(
        ambiguous
          .replace(/  extra-two:[\s\S]*?rules:/, 'rules:')
          .replace('behavior: classical', 'behavior: domain'),
      ),
    ).toThrow('类型已改变')
    expect(needsMetaRuleExtras(config(occupied))).toBe(true)
  })

  it('shares a companion for duplicate upstream URLs and fills each distinct route once', () => {
    const input = minimal('a').replace(
      'rules:\n',
      `  b: {type: http, behavior: domain, format: mrs, url: ${upstream}geosite/openai.mrs}
rules:
  - RULE-SET,b,DIRECT,no-resolve
`,
    )
    const result = upgradeMetaRuleExtras(input)
    expect(Object.keys(config(result)['rule-providers']!)).toEqual(['a', 'b', 'a-extra'])
    expect(config(result).rules).toContain('RULE-SET,a-extra,DIRECT,no-resolve')
    expect(upgradeMetaRuleExtras(result)).toBe(result)
    expect(() =>
      upgradeMetaRuleExtras(input.replace('  b: {type: http,', '  b: {interval: 99, type: http,')),
    ).toThrow('下载设置不同')
  })

  it('rejects markers pointing to another current collection but accepts an absent renamed owner', () => {
    const generated = upgradeMetaRuleExtras(source)
    expect(() =>
      upgradeMetaRuleExtras(generated.replace(`${extraMarker}: 我的微软`, `${extraMarker}: 国内`)),
    ).toThrow('来源或归属')
    expect(() =>
      upgradeMetaRuleExtras(generated.replace(`${extraMarker}: 我的微软`, `${extraMarker}: false`)),
    ).toThrow('来源或归属')
    const stale = generated.replace(`${extraMarker}: 我的微软`, `${extraMarker}: 旧名称`)
    expect(upgradeMetaRuleExtras(stale)).toBe(stale)
  })

  it('repairs a missing provider even if its routing reference already exists', () => {
    const input = minimal().replace(
      '  - MATCH,DIRECT',
      '  - RULE-SET,a-extra,DIRECT\n  - MATCH,DIRECT',
    )
    expect(needsMetaRuleExtras(config(input))).toBe(true)
    const after = upgradeMetaRuleExtras(input)
    expect(config(after).rules).toEqual(config(input).rules)
    expect(config(after)['rule-providers']!['a-extra']).toBeDefined()
    expect(needsMetaRuleExtras(config(after))).toBe(false)
  })

  it('does not duplicate the wrong route when an existing companion uses a different target', () => {
    const input = upgradeMetaRuleExtras(minimal()).replace(
      'RULE-SET,a-extra,DIRECT',
      'RULE-SET,a-extra,REJECT',
    )
    const result = upgradeMetaRuleExtras(input)
    expect(config(result).rules!.slice(0, 3)).toEqual([
      'RULE-SET,a,DIRECT',
      'RULE-SET,a-extra,DIRECT',
      'RULE-SET,a-extra,REJECT',
    ])
    expect(upgradeMetaRuleExtras(result)).toBe(result)
  })

  it('ignores ads, unsupported sources, IP collections and providers with no ordinary references', () => {
    const unchanged = [
      'mode: rule\nrules: ["MATCH,DIRECT"]\n',
      minimal('a', 'geosite/category-ads-all'),
      minimal('a', 'geoip/cn').replace('behavior: domain', 'behavior: ipcidr'),
      minimal().replace(upstream, `${upstream.replace('/geo/', '/geo-lite/')}`),
      minimal().replace('.mrs\n', '.mrs?custom=true\n'),
      minimal().replace('type: http', 'type: file'),
      minimal().replace('  - RULE-SET,a,DIRECT\n', ''),
      minimal().replace('  - RULE-SET,a,DIRECT', '  - AND,((RULE-SET,a),(NETWORK,TCP)),DIRECT'),
      minimal().replace('  - RULE-SET,a,DIRECT\n', '') +
        'dns:\n  nameserver-policy:\n    "rule-set:a": [223.5.5.5]\n',
    ]
    for (const input of unchanged) {
      expect(upgradeMetaRuleExtras(input)).toBe(input)
      expect(needsMetaRuleExtras(config(input))).toBe(false)
    }
  })

  it('preserves CRLF and supports a final rule without a trailing newline', () => {
    const crlf = source.replaceAll('\n', '\r\n')
    const next = upgradeMetaRuleExtras(crlf)
    expect(next.replaceAll('\r\n', '')).not.toContain('\n')
    expect(upgradeMetaRuleExtras(next)).toBe(next)
    const noNewline = minimal().replace('  - MATCH,DIRECT\n', '').trimEnd()
    expect(config(upgradeMetaRuleExtras(noNewline)).rules).toEqual([
      'RULE-SET,a,DIRECT',
      'RULE-SET,a-extra,DIRECT',
    ])
  })

  it('inserts into flow maps and sequences without replacing their existing contents', () => {
    for (const comma of ['', ',']) {
      const input = `rule-providers: {a: {type: http, behavior: domain, format: mrs, url: ${upstream}geosite/openai.mrs}${comma}}
rules: ["RULE-SET,a,DIRECT", "MATCH,DIRECT"]
sub-rules: {other: ["RULE-SET,a,REJECT", "MATCH,DIRECT"]}
`
      const result = upgradeMetaRuleExtras(input)
      expect(result).toContain(
        `a: {type: http, behavior: domain, format: mrs, url: ${upstream}geosite/openai.mrs}`,
      )
      expect(config(result).rules).toEqual([
        'RULE-SET,a,DIRECT',
        'RULE-SET,a-extra,DIRECT',
        'MATCH,DIRECT',
      ])
      expect(config(result)['sub-rules']!.other[1]).toBe('RULE-SET,a-extra,REJECT')
      expect(upgradeMetaRuleExtras(result)).toBe(result)
    }
  })

  it('refuses changes to shared containers or annotations it cannot preserve safely', () => {
    expect(() => upgradeMetaRuleExtras(minimal().replace('rules:', 'rules: &shared'))).toThrow(
      '共享引用',
    )
    expect(() =>
      upgradeMetaRuleExtras(minimal().replace('rule-providers:', 'rule-providers: &shared')),
    ).toThrow('共享引用')
    const annotated = minimal().replace(
      /rules:\n[\s\S]*/,
      'rules: ["RULE-SET,a,DIRECT", # keep the first rule comment\n "MATCH,DIRECT"]\n',
    )
    expect(() => upgradeMetaRuleExtras(annotated)).toThrow('行内注释')
    expect(() => upgradeMetaRuleExtras(source.replace('sub-rules:', 'sub-rules: &shared'))).toThrow(
      '共享引用',
    )
  })
})
