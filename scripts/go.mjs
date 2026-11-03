import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const bundled = resolve(root, '.tools/go/bin', process.platform === 'win32' ? 'go.exe' : 'go')
const command = process.env.MIHOMO_GO || (existsSync(bundled) ? bundled : 'go')
const child = spawn(command, process.argv.slice(2), {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
})
child.on('error', (error) => {
  console.error(error.message)
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
