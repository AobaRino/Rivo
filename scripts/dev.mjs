import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const localGo = resolve(root, '.tools/go/bin', process.platform === 'win32' ? 'go.exe' : 'go')
const go = process.env.MIHOMO_GO || (existsSync(localGo) ? localGo : 'go')
mkdirSync(resolve(root, '.local'), { recursive: true })
const processes = []
let stopping = false
const setup = spawn(go, ['run', './scripts/setup-zashboard'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
})
const setupCode = await new Promise((resolve) => {
  setup.on('error', (error) => {
    console.error(error.message)
    resolve(1)
  })
  setup.on('exit', resolve)
})
if (setupCode !== 0) process.exit(1)
function stop(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of processes) {
    try {
      child.kill()
    } catch {}
  }
  setTimeout(() => process.exit(code), 300)
}
function launch(command, args) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true })
  processes.push(child)
  child.on('error', (error) => {
    console.error(error.message)
    stop(1)
  })
  child.on('exit', (code) => {
    if (!stopping) stop(code || 0)
  })
  return child
}
console.log(
  '\n  Rivo · 本地开发\n  页面 http://127.0.0.1:5173\n  API  http://127.0.0.1:18787\n  运行控制为模拟器，不启动 Mihomo 或修改系统代理。\n',
)
// Run the built API directly so the dev runner owns both child processes.
const apiBinary = resolve(root, '.local', process.platform === 'win32' ? 'manager.exe' : 'manager')
const build = spawn(go, ['build', '-o', apiBinary, './cmd/manager'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
})
build.on('error', (error) => {
  console.error('Go 不可用：', error.message)
  stop(1)
})
await new Promise((resolve) =>
  build.on('exit', (code) => {
    if (code) stop(code)
    resolve()
  }),
)
if (!stopping) {
  launch(apiBinary, [])
  launch(process.execPath, [
    resolve(root, 'node_modules/vite/bin/vite.js'),
    '--config',
    'web/vite.config.ts',
    'web',
    '--host',
    '127.0.0.1',
  ])
  writeFileSync(
    resolve(root, '.local/dev-pids.json'),
    JSON.stringify({ runner: process.pid, children: processes.map((p) => p.pid) }),
  )
}
process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
