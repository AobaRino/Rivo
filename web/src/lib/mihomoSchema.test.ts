import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import {
  displaySchema,
  fieldCatalog,
  protocolTypes,
  protocolSchema,
  schemaProblems,
  sectionSchema,
} from './mihomoSchema'
import { SchemaFields } from '../components/SchemaFields'

const coreTypes =
  'ss ssr socks5 http vmess vless snell trojan hysteria hysteria2 wireguard tuic shadowquic gost-relay direct dns reject rematch ssh mieru anytls sudoku masque trusttunnel openvpn tailscale zerotier easytier'.split(
    ' ',
  )
describe('pinned Mihomo schema', () => {
  it('covers every ParseProxy case in Mihomo v1.19.32', () =>
    expect([...protocolTypes].sort()).toEqual([...coreTypes].sort()))
  for (const type of coreTypes)
    it(`renders ${type} without defaults or external references`, () => {
      const input = { name: 'test', type }
      const original = JSON.stringify(input)
      const definition = protocolSchema(type)!
      expect(fieldCatalog(definition).properties).toHaveProperty('name')
      expect(() => schemaProblems(definition, input)).not.toThrow()
      const output = renderToStaticMarkup(
        createElement(SchemaFields, {
          schema: definition,
          value: input,
          onChange: () => {
            throw new Error('render mutated data')
          },
        }),
      )
      expect(output).toContain('test')
      expect(output).not.toContain('Unsupported field schema')
      expect(JSON.stringify(input)).toBe(original)
    })
  it('exposes nested transports, peers and compatible input types', () => {
    const vless = displaySchema(protocolSchema('vless')!, { port: '443' })
    expect(vless.properties).toHaveProperty('xhttp-opts')
    expect(vless.properties).toHaveProperty('reality-opts')
    expect(vless.properties!.port).toMatchObject({ type: 'string' })
    expect(displaySchema(protocolSchema('wireguard')!).properties).toHaveProperty('peers')
    expect(displaySchema(sectionSchema('dns')).properties).toHaveProperty('nameserver-policy')
  })
  it('renders a newly added null array slot as the declared string, not a null-only field', () => {
    const input = { name: 'wg', type: 'wireguard', peers: [{ 'allowed-ips': [null] }] }
    const output = renderToStaticMarkup(
      createElement(SchemaFields, {
        schema: protocolSchema('wireguard')!,
        value: input,
        onChange: () => {},
      }),
    )
    expect(output).toContain('id="root_peers_0_allowed-ips_0"')
    expect(output).not.toContain('allowed-ips_0__anyof_select')
  })
  it('renders TLS condition branches as one object without synthetic XxxOf paths', () => {
    const value = {
      name: 'reality',
      type: 'vless',
      server: 'example.com',
      port: 443,
      uuid: 'test',
      tls: true,
      network: 'tcp',
      'reality-opts': { 'public-key': 'test', 'short-id': 'ab' },
    }
    const output = renderToStaticMarkup(
      createElement(SchemaFields, { schema: protocolSchema('vless')!, value, onChange: () => {} }),
    )
    expect(output.match(/id="root_name"/g)).toHaveLength(1)
    expect(output).not.toContain('XxxOf')
    expect(output).not.toContain('root__anyof_select')
    const withXhttp = { ...value, network: 'xhttp', 'xhttp-opts': {} }
    const xhttp = renderToStaticMarkup(
      createElement(SchemaFields, {
        schema: protocolSchema('vless')!,
        value: withXhttp,
        onChange: () => {},
      }),
    )
    expect(xhttp).not.toContain('id="root_xhttp-opts_download-settings_tls"')
  })
  it('keeps dictionaries open so headers can be renamed and more keys added', () => {
    const s = displaySchema({ type: 'object' }, { Host: 'example.com' })
    expect(s.additionalProperties).toBe(true)
    expect(s.properties).toEqual({})
    const output = renderToStaticMarkup(
      createElement(SchemaFields, {
        schema: { type: 'object' },
        value: { Host: 'example.com' },
        onChange: () => {},
      }),
    )
    expect(output).toContain('Host-key')
    expect(output).toContain('aria-label="删除字段 Host"')
    expect(output).not.toContain('aria-label="移除 Host"')
  })
  it('labels DNS array entries by field and position, with accessible reorder controls', () => {
    const value = { nameserver: ['https://dns.alidns.com/dns-query', '223.5.5.5'] }
    const output = renderToStaticMarkup(
      createElement(SchemaFields, { schema: sectionSchema('dns'), value, onChange: () => {} }),
    )
    expect(output).toContain('for="root_nameserver_0"')
    expect(output).toContain('nameserver 第 1 项')
    expect(output).toContain('aria-label="下移 nameserver 第 1 项"')
    expect(output).toContain('aria-label="删除 nameserver 第 2 项"')
    expect(output).not.toContain('字符串')
    expect(output).toContain('https://dns.alidns.com/dns-query')
  })
  it('keeps number, boolean and nested object controls when styling array entries', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        ports: { type: 'array' as const, items: { type: 'integer' as const } },
        peers: {
          type: 'array' as const,
          items: { type: 'object' as const, properties: { enabled: { type: 'boolean' as const } } },
        },
      },
    }
    const value = { ports: [443], peers: [{ enabled: true }] }
    const output = renderToStaticMarkup(
      createElement(SchemaFields, { schema, value, onChange: () => {} }),
    )
    expect(output).toMatch(/id="root_ports_0"[^>]*type="number"/)
    expect(output).toContain('id="root_peers_0_enabled"')
    expect(output).toContain('开启')
    expect(output).toContain('schema-array-item-complex')
  })
  it('keeps both DNS policy value types and does not default over an existing list', () => {
    const value = { 'nameserver-policy': { 'example.com': ['223.5.5.5', '119.29.29.29'] } }
    const before = JSON.stringify(value)
    const output = renderToStaticMarkup(
      createElement(SchemaFields, {
        schema: sectionSchema('dns'),
        value,
        onChange: () => {
          throw new Error('render mutated DNS policy')
        },
      }),
    )
    expect(output).toContain('文本')
    expect(output).toContain('列表')
    expect(output).toContain('223.5.5.5')
    expect(output).toContain('119.29.29.29')
    expect(output).not.toContain('[object Object]')
    expect(JSON.stringify(value)).toBe(before)
  })
})
