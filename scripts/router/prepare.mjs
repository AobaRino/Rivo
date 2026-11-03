import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const output = resolve(root, 'dist/router-sdk-package/mihomo-manager')
function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`)
}
mkdirSync(output, { recursive: true })
cpSync(resolve(root, 'packaging/openwrt/mihomo-manager'), output, { recursive: true })
mkdirSync(resolve(output, 'prebuilt'), { recursive: true })
run(
  process.execPath,
  [
    'scripts/go.mjs',
    'build',
    '-trimpath',
    '-ldflags=-s -w',
    '-o',
    resolve(output, 'prebuilt/mihomo-manager'),
    './cmd/manager',
  ],
  { GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' },
)
run(process.execPath, ['node_modules/typescript/bin/tsc', '-b', 'web'])
run(
  process.execPath,
  [
    'node_modules/vite/bin/vite.js',
    'build',
    'web',
    '--base=/',
    '--outDir',
    resolve(output, 'prebuilt/web'),
    '--emptyOutDir',
  ],
  { VITE_ROUTER: '1' },
)
if (!existsSync(resolve(output, 'prebuilt/web/index.html'))) throw new Error('Missing frontend')
mkdirSync(resolve(output, 'prebuilt/dashboard'), { recursive: true })
cpSync(resolve(root, '.local/zashboard/v3.29.1'), resolve(output, 'prebuilt/dashboard/v3.29.1'), {
  recursive: true,
})
writeFileSync(
  resolve(root, 'dist/router-sdk-package/BUILD.json'),
  JSON.stringify(
    {
      package: 'mihomo-manager',
      version: JSON.parse(readFileSync(resolve(root, 'package.json'))).version,
      target: 'ImmortalWrt 25.12 x86_64',
      coreEnabled: 'optional-procd',
    },
    null,
    2,
  ),
)
console.log(`SDK package prepared: ${output}`)
