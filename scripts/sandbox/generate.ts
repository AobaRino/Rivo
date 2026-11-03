// Generate real-core fixtures through the same mutations used by the forms.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addRule,
  analyze,
  appendItem,
  rename,
  saveProvider,
  saveRuleProvider,
  setGeoSource,
  updateGeoSettings,
} from '../../web/src/lib/document'
import { summarizeBlocks as summarizeChanges } from '../../web/src/lib/blockChanges'

const out = process.argv[2]
if (!out) throw new Error('An output directory is required')
mkdirSync(out, { recursive: true })
let text = `# Disposable sandbox configuration, separate from the saved workspace.
mixed-port: 7890
allow-lan: true
bind-address: '*'
external-controller: 0.0.0.0:9090
secret: sandbox-only-token
mode: rule
log-level: info
ipv6: false
find-process-mode: off
tun:
  enable: false
dns:
  enable: false
hosts:
  fixture: FIXTURE_IP
  node: NODE_IP
  http.sandbox.test: FIXTURE_IP
  inline.sandbox.test: FIXTURE_IP
  file.sandbox.test: FIXTURE_IP
  geo.sandbox.test: FIXTURE_IP
  update.sandbox.test: FIXTURE_IP
  plain.sandbox.test: FIXTURE_IP
rules:
  - MATCH,DIRECT
`
const seed = text
text = appendItem(text, 'proxies', {
  name: 'Manual',
  type: 'ss',
  server: 'node',
  port: 8388,
  cipher: 'aes-128-gcm',
  password: 'sandbox-test-only',
})
text = saveProvider(text, null, 'Subscription', {
  type: 'http',
  url: 'http://fixture:8080/sub.yaml',
  interval: 5,
  path: './subscription.yaml',
  'health-check': { enable: false },
})
text = appendItem(text, 'proxy-groups', {
  name: 'Mixed',
  type: 'select',
  proxies: ['Manual'],
  use: ['Subscription'],
})
text = saveRuleProvider(text, null, 'HTTP', {
  type: 'http',
  behavior: 'domain',
  format: 'yaml',
  url: 'http://fixture:8080/rules.yaml',
  path: './rules.yaml',
  interval: 5,
})
text = saveRuleProvider(text, null, 'File', {
  type: 'file',
  behavior: 'domain',
  format: 'mrs',
  path: './file.mrs',
})
text = saveRuleProvider(text, null, 'Inline', {
  type: 'inline',
  behavior: 'classical',
  payload: ['DOMAIN,inline.sandbox.test'],
})
for (const rule of [
  'RULE-SET,HTTP,Mixed',
  'RULE-SET,File,Mixed',
  'RULE-SET,Inline,Mixed',
  'GEOSITE,sandbox,Mixed',
  'GEOIP,SB,Mixed,no-resolve',
])
  text = addRule(text, rule)
text = updateGeoSettings(text, {
  'geodata-mode': true,
  'geodata-loader': 'standard',
  'geo-auto-update': false,
  'geo-update-interval': 24,
})
text = setGeoSource(text, 'geosite', 'http://fixture:8080/geosite.dat')
text = setGeoSource(text, 'geoip', 'http://fixture:8080/geoip.dat')
writeFileSync(join(out, 'client.yaml'), text)
writeFileSync(join(out, 'add-summary.json'), JSON.stringify(summarizeChanges(seed, text), null, 2))
let renamed = rename(text, 'proxies', 0, 'ManualRenamed')
renamed = saveProvider(
  renamed,
  'Subscription',
  'SubscriptionRenamed',
  analyze(renamed).config!['proxy-providers']!.Subscription,
)
renamed = saveRuleProvider(
  renamed,
  'HTTP',
  'HTTPRenamed',
  analyze(renamed).config!['rule-providers']!.HTTP,
)
writeFileSync(join(out, 'renamed.yaml'), renamed)
writeFileSync(
  join(out, 'rename-summary.json'),
  JSON.stringify(summarizeChanges(text, renamed), null, 2),
)
for (const value of [text, renamed]) {
  const errors = analyze(value).errors
  if (errors.length) throw new Error(errors.join('\n'))
}
console.log('Generated original and renamed YAML with the manager edit functions')
