import { describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { summarizeChanges } from './changes'

const summarize = (before: unknown, after: unknown) =>
  summarizeChanges(stringify(before), stringify(after))
const node = (name: string, port = 443) => ({
  name,
  type: 'vless',
  server: name + '.example.com',
  port,
})

describe('Chinese save summary', () => {
  it('lists added, modified and removed entities and concrete setting changes', () => {
    const before = {
      mode: 'rule',
      proxies: [node('keep'), node('removed')],
      'proxy-providers': {
        Airport: { type: 'http', url: 'https://example.com/old', interval: 3600 },
      },
      'proxy-groups': [{ name: 'Proxy', type: 'select', proxies: ['keep'], use: ['Airport'] }],
      dns: { enable: false, nameserver: ['1.1.1.1'] },
    }
    const after = {
      ...before,
      mode: 'global',
      proxies: [node('keep', 8443), node('added')],
      'proxy-providers': {
        Airport: { type: 'http', url: 'https://example.com/new', interval: 7200 },
      },
      'proxy-groups': [
        { name: 'Proxy', type: 'select', proxies: ['keep', 'added'], use: ['Airport'] },
      ],
      dns: { enable: true, nameserver: ['1.1.1.1', '8.8.8.8'] },
    }
    const result = summarize(before, after)
    expect(result.note).toBeUndefined()
    expect(result.changes).toContainEqual({
      kind: 'added',
      title: '自建节点「added」',
      details: [],
    })
    expect(result.changes).toContainEqual({
      kind: 'removed',
      title: '自建节点「removed」',
      details: [],
    })
    expect(result.changes).toContainEqual({
      kind: 'modified',
      title: '自建节点「keep」',
      details: ['端口：443 → 8443'],
    })
    expect(result.changes.find((item) => item.title === '启动模式')?.details).toEqual([
      '规则 → 全局',
    ])
    expect(result.changes.find((item) => item.title === 'DNS / 启用状态')?.details).toEqual([
      '关闭 → 开启',
    ])
    expect(
      result.changes.find((item) => item.title === '代理组「Proxy」')?.details.join(),
    ).toContain('新增「added」')
    expect(result.changes.find((item) => item.title === '订阅「Airport」')?.details).toContain(
      '更新间隔：3600 → 7200',
    )
  })

  it('matches named entries without treating index shifts as modifications', () => {
    const result = summarize(
      { proxies: [node('A'), node('B')] },
      { proxies: [node('X'), node('A'), node('B')] },
    )
    expect(result.changes).toEqual([{ kind: 'added', title: '自建节点「X」', details: [] }])
  })

  it('recognizes an unambiguous rename, and reports an actual reorder', () => {
    const result = summarize(
      { proxies: [node('A'), node('B')] },
      { proxies: [node('B'), { ...node('A'), name: 'C' }] },
    )
    expect(result.changes).toContainEqual({
      kind: 'modified',
      title: '自建节点「A」→「C」',
      details: ['名称：A → C'],
    })
    expect(result.changes.some((item) => item.title === '自建节点排列顺序')).toBe(true)
    expect(result.changes.every((item) => item.kind === 'modified')).toBe(true)
  })

  it('does not guess renames when multiple nodes have identical parameters', () => {
    const result = summarize(
      { proxies: [node('A'), { ...node('A'), name: 'B' }] },
      {
        proxies: [
          { ...node('A'), name: 'C' },
          { ...node('A'), name: 'D' },
        ],
      },
    )
    expect(result.changes.filter((item) => item.kind === 'added')).toHaveLength(2)
    expect(result.changes.filter((item) => item.kind === 'removed')).toHaveLength(2)
  })

  it('handles whole collections being added or removed', () => {
    const config = {
      proxies: [node('A')],
      'proxy-providers': { Airport: { type: 'http', url: 'https://example.com' } },
      rules: ['DOMAIN-SUFFIX,example.com,DIRECT', 'MATCH,Proxy'],
    }
    const added = summarize({}, config).changes
    expect(added).toHaveLength(4)
    expect(added.every((item) => item.kind === 'added')).toBe(true)
    const removed = summarize(config, {}).changes
    expect(removed).toHaveLength(4)
    expect(removed.every((item) => item.kind === 'removed')).toBe(true)
  })

  it('recognizes rule target edits and order changes without insertion noise', () => {
    const before = {
      rules: ['DOMAIN-SUFFIX,a.com,DIRECT', 'DOMAIN-SUFFIX,b.com,Proxy', 'MATCH,Proxy'],
    }
    const inserted = summarize(before, { rules: ['DOMAIN,c.com,DIRECT', ...before.rules] })
    expect(inserted.changes).toEqual([
      { kind: 'added', title: '分流规则第 1 条', details: ['DOMAIN,c.com,DIRECT'] },
    ])
    const changed = summarize(before, {
      rules: ['DOMAIN-SUFFIX,b.com,Proxy', 'DOMAIN-SUFFIX,a.com,Proxy', 'MATCH,Proxy'],
    })
    expect(changed.changes).toContainEqual({
      kind: 'modified',
      title: '分流规则第 2 条',
      details: ['DOMAIN-SUFFIX,a.com,DIRECT → DOMAIN-SUFFIX,a.com,Proxy'],
    })
    expect(changed.changes.some((item) => item.title === '分流规则顺序')).toBe(true)
    expect(changed.changes.every((item) => item.kind === 'modified')).toBe(true)
  })

  it('keeps duplicate rule occurrences when counting removals', () => {
    const result = summarize(
      { rules: ['MATCH,DIRECT', 'MATCH,DIRECT'] },
      { rules: ['MATCH,DIRECT'] },
    )
    expect(result.changes).toEqual([
      { kind: 'removed', title: '原分流规则第 2 条', details: ['MATCH,DIRECT'] },
    ])
  })

  it('does not repeat passwords, UUIDs, subscription URLs or headers', () => {
    const config = (suffix: string) => ({
      proxies: [{ ...node('A'), password: 'password-' + suffix, uuid: 'uuid-' + suffix }],
      'proxy-providers': {
        Airport: {
          type: 'http',
          url: 'https://example.com/token-' + suffix,
          header: { Authorization: ['Bearer-' + suffix] },
        },
      },
      secret: 'secret-' + suffix,
    })
    const result = summarize(config('old'), config('new'))
    const rendered = JSON.stringify(result)
    for (const secret of [
      'password-new',
      'password-old',
      'uuid-new',
      'uuid-old',
      'token-new',
      'Bearer-new',
      'secret-new',
    ])
      expect(rendered).not.toContain(secret)
    expect(result.changes.find((item) => item.title === '订阅「Airport」')?.details).toEqual([
      '链接：已修改',
      '请求头：已修改',
    ])
  })

  it('distinguishes text-only changes from setting changes, including mapping key order', () => {
    const result = summarizeChanges(
      'mode: rule\nmixed-port: 7890\n',
      '# 注释\nmixed-port: 7890\nmode: \"rule\"\n',
    )
    expect(result.changes).toEqual([])
    expect(result.note).toContain('注释、格式或字段顺序')
    expect(summarize({}, { rules: [] }).changes).toContainEqual({
      kind: 'added',
      title: '分流规则',
      details: ['0 项'],
    })
  })

  it('handles unknown settings and field additions/removals', () => {
    const result = summarize(
      { dns: { listen: '127.0.0.1:1053' }, custom: { x: 1 }, constructor: 'old' },
      { dns: { enable: true }, custom: { x: 2 }, constructor: 'new' },
    )
    expect(result.changes).toContainEqual({
      kind: 'removed',
      title: 'DNS / 监听地址',
      details: ['原值：127.0.0.1:1053'],
    })
    expect(result.changes).toContainEqual({
      kind: 'added',
      title: 'DNS / 启用状态',
      details: ['开启'],
    })
    expect(result.changes).toContainEqual({
      kind: 'modified',
      title: 'custom / x',
      details: ['1 → 2'],
    })
    expect(result.changes).toContainEqual({
      kind: 'modified',
      title: 'constructor',
      details: ['old → new'],
    })
  })

  it('falls back clearly for invalid YAML, duplicate keys and cyclic aliases', () => {
    for (const invalid of [
      'mode: [unfinished',
      'mode: rule\nmode: direct',
      'a: &loop { next: *loop }',
      '- not-a-mapping',
    ]) {
      expect(summarizeChanges('mode: rule', invalid).note).toContain('当前草稿无法解析')
      expect(summarizeChanges(invalid, 'mode: rule').note).toContain('上次保存的草稿无法解析')
    }
  })

  it('resolves shared anchors for a change to an inherited node field', () => {
    const before =
      'defaults: &defaults { type: vless, server: example.com, port: 443 }\nproxies:\n  - { <<: *defaults, name: A }\n'
    const result = summarizeChanges(before, before.replace('port: 443', 'port: 8443'))
    expect(result.changes).toContainEqual({
      kind: 'modified',
      title: '自建节点「A」',
      details: ['端口：443 → 8443'],
    })
  })

  it('makes scalar type changes visible even when the displayed values look identical', () => {
    expect(summarize({ 'mixed-port': 7890 }, { 'mixed-port': '7890' }).changes).toEqual([
      { kind: 'modified', title: '混合端口', details: ['7890（数值） → 7890（文本）'] },
    ])
  })
})
