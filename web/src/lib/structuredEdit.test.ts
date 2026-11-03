import { describe, it, expect } from 'vitest'
import { analyze, parse, references, rename, appendItem } from './document'
import { patchValue, saveProxy } from './structuredEdit'

const source = `# keep header\nproxies:\n  - name: hop\n    type: direct\n  - name: client\n    type: vless\n    server: example.com # keep server comment\n    port: '443'\n    uuid: fake-id\n    dialer-proxy: hop\n    reality-opts:\n      public-key: old # keep nested comment\n      short-id: ab\n    peers:\n      - server: a\n        port: 1\n    x-future: keep\nproxy-groups:\n  - name: select\n    type: select\n    proxies: [hop, client]\nrules:\n  - MATCH,hop\n`
describe('schema edits preserve original YAML', () => {
  it('accepts native DNS normal mode and disabled port', () => {
    expect(analyze('mixed-port: 0\ndns:\n  enhanced-mode: normal\n').errors).toEqual([])
  })
  it('supports endpoint-free builtins and leaves no-op bytes intact', () => {
    const config = analyze(source).config!
    expect(analyze(source).errors).toEqual([])
    expect(saveProxy(source, 1, config.proxies![1])).toBe(source)
    expect(saveProxy(source, 0, config.proxies![0])).toBe(source)
  })
  it('patches nested leaves and unknown fields without losing comments or scalar type', () => {
    const node = structuredClone(analyze(source).config!.proxies![1])
    ;(node['reality-opts'] as Record<string, unknown>)['public-key'] = 'new'
    ;(node.peers as { port: number }[])[0].port = 2
    node['xhttp-opts'] = { headers: { Host: 'example.org' }, 'no-grpc-header': false }
    const result = saveProxy(source, 1, node)
    expect(result).toContain('public-key: "new" # keep nested comment')
    expect(result).toContain("port: '443'")
    expect(result).toContain('x-future: keep')
    expect(parse(result).toJS().proxies[1]).toEqual(node)
  })
  it('can explicitly remove a field and preserve empty objects', () => {
    const changed = patchValue(source, ['proxies', 1, 'x-future'], undefined)
    expect(parse(changed).toJS().proxies[1]).not.toHaveProperty('x-future')
    const empty = patchValue('dns:\n  nameserver: [a]\n', ['dns'], {})
    expect(parse(empty).toJS()).toEqual({ dns: {} })
  })
  it('refuses comment-bearing deletions, shared mutations and shared array replacements', () => {
    expect(() => patchValue(source, ['proxies', 1, 'reality-opts'], undefined)).toThrow()
    expect(() => patchValue('dns: &d\n  enable: true\nx: *d\n', ['dns', 'enable'], false)).toThrow()
    expect(() =>
      patchValue('dns:\n  nameserver:\n    - a # comment\n', ['dns', 'nameserver'], ['b', 'c']),
    ).toThrow()
  })
  it('adds arrays/objects, supports empty lists, and keeps explicit document end', () => {
    expect(
      parse(
        appendItem('proxies: []\nrules: [MATCH,DIRECT]\n', 'proxies', {
          name: 'direct-test',
          type: 'direct',
        }),
      ).toJS().proxies,
    ).toHaveLength(1)
    expect(
      parse(appendItem('mode: rule\n...\n', 'proxies', { name: 'd', type: 'direct' })).errors,
    ).toEqual([])
  })
  it('updates and protects dialer, provider download and listener references', () => {
    const yaml =
      source +
      'proxy-providers:\n  sub:\n    type: http\n    url: https://example.com\n    proxy: hop\nlisteners:\n  - name: local\n    type: http\n    proxy: hop\n'
    const changed = rename(yaml, 'proxies', 0, 'hop-renamed')
    const config = parse(changed).toJS()
    expect(config.proxies[1]['dialer-proxy']).toBe('hop-renamed')
    expect(config['proxy-providers'].sub.proxy).toBe('hop-renamed')
    expect(config.listeners[0].proxy).toBe('hop-renamed')
    expect(references(analyze(yaml).config!, 'hop')).toHaveLength(5)
  })
  it('edits flow maps without dropping future fields', () => {
    const result = patchValue('dns: { enable: true, future: 5 }\n', ['dns'], {
      enable: false,
      future: 5,
      ipv6: true,
    })
    expect(parse(result).toJS().dns).toEqual({ enable: false, future: 5, ipv6: true })
  })
  it('adds a field to an existing empty map inside an array', () => {
    const result = patchValue(
      'proxies:\n  - name: w\n    type: wireguard\n    peers:\n      - {}\n',
      ['proxies', 0, 'peers', 0, 'server'],
      '192.0.2.1',
    )
    expect(parse(result).toJS().proxies[0].peers).toEqual([{ server: '192.0.2.1' }])
  })
  it('detects missing dialers and mixed node/group cycles', () => {
    expect(
      analyze('proxies:\n  - name: a\n    type: direct\n    dialer-proxy: missing\n').errors.join(),
    ).toContain('不存在')
    expect(
      analyze(
        'proxies:\n  - name: a\n    type: direct\n    dialer-proxy: g\nproxy-groups:\n  - name: g\n    type: select\n    proxies: [a]\n',
      ).errors.join(),
    ).toContain('循环')
  })
})
