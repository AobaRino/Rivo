// Optional integration check against an official local Mihomo executable.
// All traffic is loopback: no proxy ports, DNS listener, TUN or system changes.
// node scripts/check-group-order.mjs <absolute-path-to-mihomo>
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as netServer } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import ts from 'typescript'
import { stringify } from 'yaml'

const binary = resolve(process.argv[2] || '')
if (!process.argv[2]) throw new Error('Pass the path to an official local Mihomo executable')
const source = await readFile(new URL('../web/src/lib/groupOrder.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const { withOrder } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
)
const parent = resolve('.local/group-order-qa')
await mkdir(parent, { recursive: true })
const dir = await mkdtemp(join(parent, 'core-run-'))
const socket = netServer().listen(0, '127.0.0.1')
await once(socket, 'listening')
const port = socket.address().port
await new Promise((done) => socket.close(done))
let names = ['Sub-A', 'Sub-B', 'Drop', 'Sub-Skip']
const provider = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/yaml')
  res.end(stringify({ proxies: names.map((name) => ({ name, type: 'direct' })) }))
})
provider.listen(0, '127.0.0.1')
await once(provider, 'listening')
const baseGroup = {
  name: 'Order',
  type: 'select',
  proxies: ['Self', 'DIRECT'],
  use: ['test'],
  filter: 'Sub',
  'exclude-filter': 'Skip',
}
const config = {
  mode: 'rule',
  'log-level': 'warning',
  'mixed-port': 0,
  port: 0,
  'socks-port': 0,
  'redir-port': 0,
  'tproxy-port': 0,
  'allow-lan': false,
  'bind-address': '127.0.0.1',
  'external-controller': `127.0.0.1:${port}`,
  secret: 'local-order-check',
  dns: { enable: false },
  tun: { enable: false },
  profile: { 'store-selected': true },
  proxies: [{ name: 'Self', type: 'direct' }],
  'proxy-providers': {
    test: {
      type: 'http',
      url: `http://127.0.0.1:${provider.address().port}/nodes`,
      path: './provider.yaml',
      interval: 0,
      'health-check': { enable: false },
    },
  },
  'proxy-groups': [baseGroup],
  rules: ['MATCH,DIRECT'],
}
const path = join(dir, 'config.yaml')
await writeFile(path, stringify(config))
let output = ''
const child = spawn(binary, ['-d', dir, '-f', path], {
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', (b) => {
  output += b
})
child.stderr.on('data', (b) => {
  output += b
})
const exited = once(child, 'exit')
const request = async (endpoint, method = 'GET', body) => {
  const r = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method,
    headers: { Authorization: 'Bearer local-order-check', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  })
  if (!r.ok) throw new Error(`${endpoint}: ${r.status} ${await r.text()}`)
  return r.status === 204 ? undefined : r.json()
}
const wait = async (fn) => {
  let last
  for (let i = 0; i < 50; i++) {
    try {
      return await fn()
    } catch (e) {
      last = e
      await new Promise((done) => setTimeout(done, 100))
    }
  }
  throw last
}
const group = () => request('/proxies/Order')
try {
  const version = await wait(() => request('/version'))
  await wait(async () => {
    assert.ok((await group()).all.includes('Sub-A'))
  })
  await request('/proxies/Order', 'PUT', { name: 'Sub-A' })
  const ordered = withOrder(baseGroup, ['Sub-B', 'Self', 'DIRECT', 'Sub-A', 'Drop'])
  config['proxy-groups'] = [ordered]
  await writeFile(path, stringify(config))
  await request('/configs?force=true', 'PUT', { path })
  await wait(async () => {
    const g = await group()
    assert.deepEqual(g.all, ['Sub-B', 'Self', 'DIRECT', 'Sub-A'])
    assert.equal(g.now, 'Sub-A')
  })
  for (const [next, expected] of [
    [
      ['Sub-New', 'Sub-A', 'Sub-B', 'Drop'],
      ['Sub-B', 'Self', 'DIRECT', 'Sub-A', 'Sub-New'],
    ],
    [
      ['Sub-New', 'Sub-A'],
      ['Self', 'DIRECT', 'Sub-A', 'Sub-New'],
    ],
    [
      ['Sub-A', 'Sub-New', 'Sub-B'],
      ['Sub-B', 'Self', 'DIRECT', 'Sub-A', 'Sub-New'],
    ],
  ]) {
    names = next
    await request('/providers/proxies/test', 'PUT')
    await wait(async () => {
      const g = await group()
      assert.deepEqual(g.all, expected)
      assert.equal(g.now, 'Sub-A')
    })
  }
  const literal = 'Sub.[1]` #\\测试'
  names = [literal, 'Sub-A', 'Sub-B']
  await request('/providers/proxies/test', 'PUT')
  config['proxy-groups'] = [withOrder(baseGroup, [literal, 'Sub-B', 'Self', 'Sub-A', 'DIRECT'])]
  await writeFile(path, stringify(config))
  await request('/configs?force=true', 'PUT', { path })
  await wait(async () => {
    const g = await group()
    assert.deepEqual(g.all, [literal, 'Sub-B', 'Self', 'Sub-A', 'DIRECT'])
    assert.equal(g.now, 'Sub-A')
  })
  const actual = await request('/configs')
  for (const key of ['port', 'mixed-port', 'socks-port', 'redir-port', 'tproxy-port'])
    assert.equal(actual[key], 0)
  assert.equal(actual.tun.enable, false)
  console.log(
    `Mihomo ${version.version}: mixed order, filtering, provider reorder/add/remove/return, literal names and selection retention passed; all proxy ports and TUN disabled.`,
  )
} catch (error) {
  console.error(output)
  throw error
} finally {
  child.kill()
  await exited
  provider.closeAllConnections()
  await new Promise((done) => provider.close(done))
  if (!dir.startsWith(parent + '\\') && !dir.startsWith(parent + '/'))
    throw new Error('Unexpected test directory')
  await rm(dir, { recursive: true, force: true })
}
