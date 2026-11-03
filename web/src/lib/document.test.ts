import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  addRule,
  analyze,
  appendItem,
  moveItem,
  parse,
  removeItem,
  rename,
  setValue,
  saveProvider,
  removeProvider,
  setStringList,
} from './document'

const seed = readFileSync(new URL('../../../configs/example.yaml', import.meta.url), 'utf8')
const subscription = {
  type: 'http' as const,
  url: 'https://example.com/sub?token=demo',
  interval: 3600,
}

describe('subscriptions', () => {
  it('preserves an omitted interval and allows clearing it without changing other fields', () => {
    const input =
      'proxy-providers:\n  A:\n    type: http\n    url: "https://example.com" # retained\n    proxy: DIRECT\n'
    const provider = { type: 'http' as const, url: 'https://example.com' }
    expect(saveProvider(input, 'A', 'A', provider)).toBe(input)
    const withInterval = saveProvider(input, 'A', 'A', { ...provider, interval: 3600 })
    const cleared = saveProvider(withInterval, 'A', 'A', provider)
    expect(analyze(cleared).config?.['proxy-providers']?.A).toEqual({
      ...provider,
      proxy: 'DIRECT',
    })
    expect(cleared).toContain('# retained')
    expect(() => saveProvider(input, 'A', 'A', { ...provider, interval: NaN })).toThrow('非负整数')
  })
  it('detects cycles introduced through group membership', () => {
    expect(
      analyze(
        'proxy-groups: [{name: A, type: select, proxies: [B]}, {name: B, type: select, proxies: [A]}]',
      ).errors.join(),
    ).toContain('循环引用')
  })
  it('adds and removes the last provider without changing self-built nodes', () => {
    const added = saveProvider(seed, null, '机场 A', subscription)
    expect(added.startsWith(seed)).toBe(true)
    expect(analyze(added).config?.['proxy-providers']?.['机场 A']).toEqual(subscription)
    const removed = removeProvider(added, '机场 A')
    expect(removed.startsWith(seed)).toBe(true)
    expect(analyze(removed).errors).toEqual([])
    expect(analyze(removed).config?.['proxy-providers']).toEqual({})
    const restored = saveProvider(removed, null, 'New', subscription)
    expect(analyze(restored).config?.['proxy-providers']?.New).toEqual(subscription)
  })
  it('updates a subscription without dropping headers, comments or other providers', () => {
    const input =
      'proxy-providers:\r\n  A:\r\n    type: http\r\n    url: "https://old.example.com" # keep\r\n    interval: 30\r\n    header: {Authorization: [secret]}\r\n  B: {type: inline, payload: []}\r\nx-custom: untouched\r\n'
    const next = saveProvider(input, 'A', 'A', subscription)
    expect(next).toContain('# keep\r\n')
    expect(next).toContain(
      '    header: {Authorization: [secret]}\r\n  B: {type: inline, payload: []}\r\nx-custom: untouched\r\n',
    )
    expect(analyze(next).config?.['proxy-providers']?.A.header).toEqual({
      Authorization: ['secret'],
    })
  })
  it('can mix local nodes and subscription references, and rename references together', () => {
    let next = saveProvider(seed, null, 'A', subscription)
    next = setStringList(next, ['proxy-groups', 0, 'use'], ['A'])
    next = setStringList(next, ['proxy-groups', 0, 'proxies'], ['香港 · Reality', 'DIRECT'])
    expect(analyze(next).errors).toEqual([])
    expect(() => removeProvider(next, 'A')).toThrow('引用')
    next = saveProvider(next, 'A', 'Renamed', subscription)
    expect(analyze(next).config?.['proxy-groups']?.[0].use).toEqual(['Renamed'])
    expect(analyze(next).config?.['proxy-groups']?.[0].proxies).toEqual([
      '香港 · Reality',
      'DIRECT',
    ])
    expect(analyze(next).config?.proxies).toEqual(analyze(seed).config?.proxies)
    next = setStringList(next, ['proxy-groups', 0, 'use'], [])
    expect(analyze(removeProvider(next, 'Renamed')).errors).toEqual([])
  })
  it('rejects missing providers, duplicate names and unsafe rewrites', () => {
    expect(analyze('proxy-groups: [{name: A, type: select, use: [missing]}]').errors[0]).toContain(
      '不存在的订阅',
    )
    const input = saveProvider(seed, null, 'A', subscription)
    expect(() => saveProvider(input, null, 'A', subscription)).toThrow('重复')
    expect(() =>
      setStringList(
        'proxy-groups:\n  - name: G\n    proxies: &shared [DIRECT]\n',
        ['proxy-groups', 0, 'proxies'],
        [],
      ),
    ).toThrow()
    expect(() =>
      saveProvider(
        'base: &base {type: http, url: "https://example.com"}\nproxy-providers:\n  A:\n    <<: *base\n',
        'A',
        'A',
        subscription,
      ),
    ).toThrow()
  })
})
describe('YAML document edits', () => {
  it('keeps all text outside an edited scalar, including CRLF and unknown fields', () => {
    const input = '# 中文 😀\r\nmode: rule # retain\r\nx-secret: "0123"\r\n'
    expect(setValue(input, ['mode'], 'global')).toBe(
      '# 中文 😀\r\nmode: "global" # retain\r\nx-secret: "0123"\r\n',
    )
  })
  it('does not silently stringify an anchored scalar or merged mapping', () => {
    expect(() => setValue('mode: &shared rule\nx: *shared\n', ['mode'], 'global')).toThrow()
    expect(() =>
      setValue('base: &base {enable: true}\ndns:\n  <<: *base\n', ['dns', 'enable'], false),
    ).toThrow()
  })
  it('keeps numeric-looking strings as strings', () => {
    for (const value of ['0123', 'true', '# literal', 'null', '', '中文😀']) {
      const next = setValue('name: initial\n', ['name'], value)
      expect(parse(next).toJS().name).toBe(value)
    }
  })
  it('appends a node without changing the existing sequence or following sections', () => {
    const next = appendItem(seed, 'proxies', {
      name: 'New',
      type: 'ss',
      server: 'new.example.com',
      port: 443,
      password: 'demo',
      cipher: 'aes-128-gcm',
    })
    const data = analyze(next)
    expect(data.errors).toEqual([])
    expect(data.config?.proxies?.length).toBe(5)
    expect(next.slice(next.indexOf('proxy-groups:'))).toBe(
      seed.slice(seed.indexOf('proxy-groups:')),
    )
    expect(data.config?.proxies?.[4].name).toBe('New')
  })
  it('appends to an absent section and preserves the original document', () => {
    const input = 'mode: rule\nx-custom: keep\n'
    const next = appendItem(input, 'rules', 'MATCH,DIRECT')
    expect(next.startsWith(input)).toBe(true)
    expect(analyze(next).config?.rules).toEqual(['MATCH,DIRECT'])
  })
  it('adds a scalar to a block mapping without changing adjacent objects', () => {
    const next = setValue('dns:\n  enable: true\nmode: rule\n', ['dns', 'listen'], '127.0.0.1:1053')
    expect(parse(next).toJS()).toEqual({
      dns: { enable: true, listen: '127.0.0.1:1053' },
      mode: 'rule',
    })
  })
  it('moves rules and removes an item without breaking the sequence', () => {
    const next = moveItem(seed, 'rules', 0, 1)
    expect(analyze(next).config?.rules?.slice(0, 2)).toEqual([
      'DOMAIN-SUFFIX,github.com,PROXY',
      'DOMAIN-SUFFIX,google.com,PROXY',
    ])
    const removed = removeItem(next, 'rules', 0)
    expect(analyze(removed).errors).toEqual([])
    expect(analyze(removed).config?.rules?.length).toBe(7)
  })
  it('updates all name references together', () => {
    const next = rename(seed, 'proxies', 0, '香港 新名称')
    const cfg = analyze(next)
    expect(cfg.errors).toEqual([])
    expect(cfg.config?.['proxy-groups']?.[0].proxies?.[0]).toBe('香港 新名称')
    expect(next).toContain('public-key: DEMO_NOT_A_REAL_PUBLIC_KEY')
  })
  it('preserves invalid source and reports duplicate keys', () => {
    const text = 'mode: rule\nmode: global\n'
    expect(analyze(text).errors.length).toBeGreaterThan(0)
    expect(() => setValue(text, ['mode'], 'direct')).toThrow()
  })
  it('inserts new rules before the catch-all without rewriting surrounding text', () => {
    const input =
      'mode: rule\r\nrules:\r\n  - DOMAIN,old.example.com,DIRECT\r\n  - MATCH,DIRECT\r\nx-note: keep\r\n'
    const next = addRule(input, 'DOMAIN,new.example.com,REJECT')
    expect(analyze(next).config?.rules).toEqual([
      'DOMAIN,old.example.com,DIRECT',
      'DOMAIN,new.example.com,REJECT',
      'MATCH,DIRECT',
    ])
    expect(next).toBe(
      input.replace('  - MATCH,DIRECT', '  - "DOMAIN,new.example.com,REJECT"\r\n  - MATCH,DIRECT'),
    )
    expect(() => addRule(input, 'MATCH,REJECT')).toThrow()
  })
  it('does not expose structurally invalid objects to forms', () => {
    for (const text of [
      'proxies: [null]',
      'rules: [12]',
      'proxy-groups: [{name: test, type: select, proxies: 1}]',
    ]) {
      const result = analyze(text)
      expect(result.config).toBeNull()
      expect(result.errors.length).toBeGreaterThan(0)
    }
  })
})
