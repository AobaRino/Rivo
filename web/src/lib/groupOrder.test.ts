import { describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { analyze, patchValue, rename, type Config, type Group } from './document'
import {
  cleanOrder,
  cleanOrderNames,
  inspectOrder,
  memberSources,
  moveActiveOrder,
  orderedRows,
  orderFilter,
  orderProblem,
  readOrder,
  sourceGroup,
  withOrder,
  type GroupMember,
  type MemberSource,
} from './groupOrder'
import { summarizeBlocks } from './blockChanges'

const group: Group = {
  name: '默认出口',
  type: 'select',
  proxies: ['自建', 'DIRECT'],
  use: ['订阅'],
  'exclude-filter': '过期',
}
describe('group ordering', () => {
  it('stores stable names, sorts explicit references and leaves provider use intact', () => {
    const next = withOrder(group, ['US-LA', 'DIRECT', '自建', 'LA-HY2'])
    expect(next.proxies).toEqual(['DIRECT', '自建'])
    expect(next.use).toEqual(['订阅'])
    expect(next['exclude-filter']).toBe('过期')
    expect(next.filter).toBe('\\AUS-LA\\z`\\ADIRECT\\z`\\A自建\\z`\\ALA-HY2\\z`[\\s\\S]*')
    expect(readOrder(next)?.names).toEqual(['US-LA', 'DIRECT', '自建', 'LA-HY2'])
    expect(orderProblem(next)).toBeUndefined()
  })
  it('keeps missing positions and appends new nodes despite subscription reordering', () => {
    const saved = ['B', '自建', 'A']
    const node = (name: string) => ({ name, type: 'Vless', source: '订阅' })
    expect(
      orderedRows(saved, ['C', 'A', '自建'].map(node)).map((n) => [n.name, n.missing]),
    ).toEqual([
      ['B', true],
      ['自建', false],
      ['A', false],
      ['C', false],
    ])
    expect(orderedRows(saved, ['C', 'A', 'B', '自建'].map(node)).map((n) => n.name)).toEqual([
      'B',
      '自建',
      'A',
      'C',
    ])
  })
  it('keeps each original filter branch as a tail and restores it on disabling sorting', () => {
    const base = { ...group, filter: '(?i)HK`US.*TLS' }
    const next = withOrder(base, ['DIRECT', 'US-LA-TLS'])
    expect(next.filter).toContain('(?=(?s:.*?)(?:(?i)HK))\\AUS-LA-TLS\\z')
    expect(next.filter).toContain('(?=(?s:.*?)(?:US.*TLS))\\AUS-LA-TLS\\z')
    expect(String(next.filter).endsWith('`(?i)HK`US.*TLS')).toBe(true)
    expect(sourceGroup(next).filter).toBe(base.filter)
    expect(sourceGroup(next)['x-manager-order']).toBeUndefined()
    expect(orderProblem({ ...next, filter: 'edited' })).toContain('filter')
  })
  it('escapes regex syntax, whitespace and native delimiters in node names', () => {
    const filter = orderFilter(group, { version: 1, names: ['a.b[1]` #\\\n'] })
    expect(filter).toBe(
      '\\Aa\\u002eb\\u005b1\\u005d\\u0060\\u0020\\u0023\\u005c\\u000a\\z`[\\s\\S]*',
    )
  })
  it('renames native references and stored ordering without rewriting unrelated YAML', () => {
    const config = {
      proxies: [{ name: '自建', type: 'direct' }],
      'proxy-providers': { 订阅: { type: 'inline', payload: [] } },
      'proxy-groups': [withOrder(group, ['US', '自建'])],
    }
    const text = '# keep\n' + stringify(config)
    const next = rename(text, 'proxies', 0, '家庭')
    const result = analyze(next).config!['proxy-groups']![0]
    expect(result.proxies).toContain('家庭')
    expect(readOrder(result)?.names).toEqual(['US', '家庭'])
    expect(orderProblem(result)).toBeUndefined()
    expect(next.startsWith('# keep\n')).toBe(true)
  })
  it('edits only the proxy-groups block and keeps unrelated fields', () => {
    const before = stringify({
      'proxy-groups': [group],
      profile: { 'store-selected': true },
      dns: { enable: true },
    })
    const after = patchValue(before, ['proxy-groups', 0], withOrder(group, ['US', '自建']))
    expect(summarizeBlocks(before, after).changes.map((c) => c.key)).toEqual(['proxy-groups'])
    expect(analyze(after).config?.profile).toEqual({ 'store-selected': true })
  })
  it('uses runtime members only when the provider definition matches the applied version', () => {
    const config: Config = {
      'proxy-providers': { 订阅: { type: 'http', url: 'https://example.com/one' } },
    }
    const live = {
      appliedRevision: 'rev',
      providers: [
        {
          name: '订阅',
          type: 'http',
          nodes: 1,
          state: 'loaded' as const,
          members: [{ name: 'A', type: 'Vless' }],
        },
      ],
    }
    expect(memberSources(config, group, live, config).sources[1].nodes).toHaveLength(1)
    expect(memberSources(config, group, live, config).complete).toBe(true)
    const changed = {
      'proxy-providers': { 订阅: { type: 'http' as const, url: 'https://example.com/two' } },
    }
    expect(memberSources(changed, group, live, config).sources[1].nodes).toHaveLength(0)
    expect(memberSources(changed, group, live, config).notices).toHaveLength(1)
    expect(memberSources(changed, group, live, config).complete).toBe(false)
  })
  it('detects ambiguous names across automatic nodes and subscriptions', () => {
    const config: Config = {
      proxies: [{ name: 'Same', type: 'direct' }],
      'proxy-providers': { 订阅: { type: 'inline', payload: [{ name: 'Same', type: 'direct' }] } },
    }
    const automatic = { ...group, proxies: ['Same'], 'include-all': true }
    const result = memberSources(config, automatic)
    expect(result.sources[0].automaticNodes?.map((n) => n.name)).toEqual(['Same'])
    expect(result.duplicates).toEqual(['Same'])
    expect(result.complete).toBe(false)
    expect(memberSources({ ...config, 'proxy-providers': {} }, automatic).duplicates).toEqual([])
  })
})

describe('stale ordering records', () => {
  const member = (name: string, source = '订阅'): GroupMember => ({ name, type: 'Vless', source })
  const sources: MemberSource[] = [
    { name: '手动成员', manual: true, nodes: [member('自建', '自建'), member('DIRECT', '内置')] },
    { name: '订阅', manual: false, nodes: ['A', '新名字', '隐藏'].map((n) => member(n)) },
    { name: '另一个订阅', manual: false, nodes: [member('B', '另一个订阅')] },
  ]
  const saved = ['旧名字', 'B', '自建', '隐藏', 'A', 'DIRECT']
  const visible = ['A', '新名字', '自建', 'DIRECT', 'B'].map((n) => member(n))

  it('separates renamed records from active and filtered members across all sources', () => {
    const result = inspectOrder(saved, sources, visible, true)
    expect(result.active.map((n) => n.name)).toEqual(['B', '自建', 'A', 'DIRECT', '新名字'])
    expect(result.stale).toEqual(['旧名字'])
    expect(result.hidden).toEqual(['隐藏'])
    expect(result.unresolved).toEqual([])
    expect(cleanOrderNames(saved, sources, true)).toEqual(['B', '自建', '隐藏', 'A', 'DIRECT'])
  })

  it('preserves observed active order, references and filters while removing only stale ranks', () => {
    const base = {
      ...group,
      use: ['订阅', '另一个订阅'],
      filter: '(?i)A|B|新名字',
      'exclude-type': 'Reject',
    }
    const ordered = withOrder(base, saved)
    // Cleanup must not normalize explicit references changed independently in YAML.
    ordered.proxies = ['DIRECT', '自建']
    const before = JSON.stringify(ordered)
    const cleaned = cleanOrder(ordered, sources, true)
    expect(readOrder(cleaned)?.names).toEqual(['B', '自建', '隐藏', 'A', 'DIRECT'])
    expect(
      inspectOrder(readOrder(cleaned)!.names, sources, visible, true).active.map((n) => n.name),
    ).toEqual(inspectOrder(saved, sources, visible, true).active.map((n) => n.name))
    expect(sourceGroup(cleaned)).toEqual(sourceGroup(ordered))
    expect(cleaned.proxies).toEqual(['DIRECT', '自建'])
    expect(cleaned.use).toEqual(['订阅', '另一个订阅'])
    expect(cleaned.filter).not.toContain('旧名字')
    expect(orderProblem(cleaned)).toBeUndefined()
    expect(JSON.stringify(ordered)).toBe(before)
    expect(cleanOrder(cleaned, sources, true)).toBe(cleaned)
  })

  it('keeps unknown records when any provider is unreadable and rejects cleanup', () => {
    const partial = sources.slice(0, 1)
    const result = inspectOrder(saved, partial, partial[0].nodes, false)
    expect(result.stale).toEqual([])
    expect(result.unresolved).toEqual(['旧名字', 'B', '隐藏', 'A'])
    expect(result.active.map((n) => n.name)).toEqual(['自建', 'DIRECT'])
    expect(() => cleanOrder(withOrder(group, saved), partial, false)).toThrow('尚未完整确认')
    expect(() => cleanOrderNames(saved, [...sources, sources[1]], true)).toThrow('尚未完整确认')
  })

  it('moves only visible members, retaining hidden and unresolved positions', () => {
    const names = ['旧名字', 'B', '隐藏', 'A', '未知']
    const moved = moveActiveOrder(names, ['B', 'A', '新节点'], 2, 0)
    expect(moved).toEqual(['旧名字', '新节点', '隐藏', 'B', '未知', 'A'])
    expect(names).toEqual(['旧名字', 'B', '隐藏', 'A', '未知'])
    expect(moveActiveOrder(names, ['B', 'A'], -1, 1)).toEqual(names)
  })

  it('retains new/unranked nodes through the catch-all when all saved names expired', () => {
    const ordered = withOrder({ name: '选择', type: 'select', use: ['订阅'] }, ['旧名字'])
    const cleaned = cleanOrder(ordered, [sources[1]], true)
    expect(readOrder(cleaned)?.names).toEqual([])
    expect(cleaned.filter).toBe('[\\s\\S]*')
    expect(inspectOrder([], [sources[1]], visible, true).active.map((n) => n.name)).toEqual(
      visible.map((n) => n.name),
    )
    expect(cleaned.use).toEqual(['订阅'])
    expect(orderProblem(cleaned)).toBeUndefined()
  })

  it('includes automatic manual nodes when deciding whether a name still exists', () => {
    const automatic = [
      { name: '手动成员', manual: true, nodes: [], automaticNodes: [member('自动包含')] },
    ]
    expect(cleanOrderNames(['自动包含', '旧名字'], automatic, true)).toEqual(['自动包含'])
    expect(inspectOrder(['自动包含'], automatic, [], true).hidden).toEqual(['自动包含'])
  })

  it('refuses cleanup when an independently edited native filter would be overwritten', () => {
    const ordered = { ...withOrder(group, saved), filter: 'edited' }
    expect(() => cleanOrder(ordered, sources, true)).toThrow('filter 已在 YAML 中修改')
  })

  it('requires populated, complete runtime results but accepts a known empty inline provider', () => {
    const config: Config = {
      'proxy-providers': { 订阅: { type: 'http', url: 'https://example.com/sub' } },
    }
    for (const state of ['empty', 'missing', 'loaded'] as const) {
      const live = {
        appliedRevision: 'rev',
        providers: [{ name: '订阅', type: 'http', nodes: 0, state, members: [] }],
      }
      const result = memberSources(config, group, live, config)
      expect(result.complete).toBe(false)
      expect(result.notices).toHaveLength(1)
      expect(() => cleanOrderNames(['旧名字'], result.sources, result.complete)).toThrow()
    }
    const incomplete = memberSources(
      config,
      group,
      {
        appliedRevision: 'rev',
        providers: [
          {
            name: '订阅',
            type: 'http',
            nodes: 2,
            state: 'loaded',
            members: [{ name: 'A', type: 'Vless' }],
          },
        ],
      },
      config,
    )
    expect(incomplete.complete).toBe(false)
    expect(memberSources(config, group).complete).toBe(false)
    const inline: Config = { 'proxy-providers': { 订阅: { type: 'inline', payload: [] } } }
    const result = memberSources(inline, group)
    expect(result.complete).toBe(true)
    expect(cleanOrderNames(['旧名字', 'DIRECT'], result.sources, result.complete)).toEqual([
      'DIRECT',
    ])
    expect(
      memberSources({ 'proxy-providers': { 订阅: { type: 'inline', payload: [{}] } } }, group)
        .complete,
    ).toBe(false)
  })
})
