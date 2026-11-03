import { expect, it } from 'vitest'
import { lineCounts, summarizeBlocks } from './blockChanges'

it('summarizes DNS as one block and counts actual lines', () => {
  expect(
    summarizeBlocks('dns:\n  enable: false\n', 'dns:\n  enable: true\n  ipv6: true\n').changes,
  ).toEqual([{ key: 'dns', title: 'DNS', added: 2, removed: 1 }])
})
it('combines node additions, edits and removals without exposing fields or secrets', () => {
  const result = summarizeBlocks(
    'proxies:\n  - name: old\n    password: secret-before\n',
    'proxies:\n  - name: new\n    password: secret-after\n',
  )
  expect(result.changes).toEqual([{ key: 'proxies', title: '节点', added: 2, removed: 2 }])
  expect(JSON.stringify(result)).not.toContain('secret')
})
it('counts pure additions, deletions and CRLF correctly', () => {
  expect(lineCounts(['a', 'b'], ['a', 'c', 'd'])).toEqual({ added: 2, removed: 1 })
  expect(
    summarizeBlocks('mode: rule\r\n', 'mode: rule\r\ndns:\r\n  enable: true\r\n').changes,
  ).toEqual([{ key: 'dns', title: 'DNS', added: 2, removed: 0 }])
  expect(summarizeBlocks('dns:\n  enable: true\n', '').changes).toEqual([
    { key: 'yaml', title: 'YAML 配置', added: 0, removed: 2 },
  ])
})
