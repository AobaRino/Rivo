// Controlled peers only: these YAMLs never contain the user's real nodes.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Document } from 'yaml'
import { saveProxy } from '../../web/src/lib/structuredEdit'
import { analyze, patchValue, rename } from '../../web/src/lib/document'
import { summarizeBlocks } from '../../web/src/lib/blockChanges'

const out = process.argv[2]
mkdirSync(out, { recursive: true })
const uuid = '21c7781d-8d3a-4a48-b529-0fc537a2d642'
const password = 'sandbox-test-only'
const tls = { certificate: '/config/cert.pem', 'private-key': '/config/key.pem' }
const clientTLS = { 'skip-cert-verify': true, sni: 'sandbox.test' }
const cases: {
  name: string
  type: string
  port: number
  node: object
  client: object
  udp?: boolean
}[] = [
  {
    name: 'HTTP',
    type: 'http',
    port: 8401,
    node: { type: 'http', users: [{ username: 'sandbox', password }] },
    client: { username: 'sandbox', password },
  },
  {
    name: 'SOCKS5',
    type: 'socks5',
    port: 8402,
    node: { type: 'socks', users: [{ username: 'sandbox', password }], udp: true },
    client: { username: 'sandbox', password, udp: true },
    udp: true,
  },
  {
    name: 'VMess',
    type: 'vmess',
    port: 8403,
    node: { type: 'vmess', users: [{ username: 'sandbox', uuid, alterId: 0 }] },
    client: { uuid, alterId: 0, cipher: 'auto', udp: true },
    udp: true,
  },
  {
    name: 'VLESS',
    type: 'vless',
    port: 8404,
    node: { type: 'vless', users: [{ username: 'sandbox', uuid }] },
    client: { uuid, udp: true },
    udp: true,
  },
  {
    name: 'Trojan',
    type: 'trojan',
    port: 8405,
    node: { type: 'trojan', users: [{ username: 'sandbox', password }], ...tls },
    client: { password, ...clientTLS, udp: true },
    udp: true,
  },
  {
    name: 'AnyTLS',
    type: 'anytls',
    port: 8406,
    node: { type: 'anytls', users: { sandbox: password }, ...tls },
    client: { password, ...clientTLS, udp: true },
    udp: true,
  },
  {
    name: 'Hysteria2',
    type: 'hysteria2',
    port: 8407,
    node: { type: 'hysteria2', users: { sandbox: password }, ...tls },
    client: { password, ...clientTLS },
    udp: true,
  },
  {
    name: 'TUIC',
    type: 'tuic',
    port: 8408,
    node: { type: 'tuic', users: { [uuid]: password }, alpn: ['h3'], ...tls },
    client: { uuid, password, alpn: ['h3'], ...clientTLS },
    udp: true,
  },
  {
    name: 'VLESS-WS',
    type: 'vless',
    port: 8409,
    node: { type: 'vless', users: [{ username: 'sandbox', uuid }], 'ws-path': '/ws' },
    client: { uuid, network: 'ws', 'ws-opts': { path: '/ws', headers: { Host: 'sandbox.test' } } },
  },
  {
    name: 'VLESS-XHTTP',
    type: 'vless',
    port: 8410,
    node: {
      type: 'vless',
      users: [{ username: 'sandbox', uuid }],
      'xhttp-config': { path: '/xhttp' },
    },
    client: { uuid, network: 'xhttp', 'xhttp-opts': { path: '/xhttp', mode: 'auto' } },
  },
  {
    name: 'SS',
    type: 'ss',
    port: 8411,
    node: { type: 'shadowsocks', cipher: 'aes-128-gcm', password },
    client: { cipher: 'aes-128-gcm', password, udp: true },
    udp: true,
  },
]
for (const c of cases) {
  if (c.type === 'vless') {
    c.node = { ...c.node, ...tls }
    c.client = { ...c.client, tls: true, servername: 'sandbox.test', ...clientTLS }
  }
}
const common = {
  mode: 'rule',
  'log-level': 'info',
  ipv6: false,
  'find-process-mode': 'off',
  dns: { enable: false },
  tun: { enable: false },
  hosts: { 'origin.sandbox.test': 'FIXTURE_IP' },
}
writeFileSync(
  join(out, 'protocols-node.json'),
  JSON.stringify(
    {
      ...common,
      listeners: cases.map((c) => ({ name: c.name, listen: '0.0.0.0', port: c.port, ...c.node })),
      rules: ['MATCH,DIRECT'],
    },
    null,
    2,
  ),
)
let text = new Document({
  ...common,
  'mixed-port': 7890,
  'allow-lan': true,
  'bind-address': '*',
  'external-controller': '0.0.0.0:9090',
  secret: 'sandbox-only-token',
  rules: ['MATCH,Protocols'],
}).toString()
for (const c of cases)
  text = saveProxy(text, -1, {
    name: c.name,
    type: c.type,
    server: 'NODE_IP',
    port: c.port,
    ...c.client,
  })
text = patchValue(
  text,
  ['proxy-groups'],
  [{ name: 'Protocols', type: 'select', proxies: cases.map((c) => c.name) }],
)
// Also exercise native targets in sub-rules and src parameters in manager rename.
text = patchValue(text, ['sub-rules'], {
  branch: ['DOMAIN,origin.sandbox.test,Protocols', 'MATCH,DIRECT'],
})
text = patchValue(
  text,
  ['rules'],
  [
    'IP-CIDR,198.18.0.0/15,Protocols,src,no-resolve',
    'SUB-RULE,(NETWORK,TCP),branch',
    'MATCH,Protocols',
  ],
)
const renamed = rename(text, 'proxy-groups', 0, 'ProtocolsRenamed')
for (const value of [text, renamed])
  if (analyze(value).errors.length) throw new Error(analyze(value).errors.join('\n'))
writeFileSync(join(out, 'protocols-client.yaml'), text)
writeFileSync(join(out, 'protocols-renamed.yaml'), renamed)
writeFileSync(
  join(out, 'protocols-summary.json'),
  JSON.stringify(summarizeBlocks(text, renamed), null, 2),
)
writeFileSync(
  join(out, 'protocols-cases.json'),
  JSON.stringify(
    cases.map(({ name, type, udp }) => ({ name, type, udp: !!udp })),
    null,
    2,
  ),
)
console.log('Generated', cases.length, 'controlled protocol/transport fixtures')
