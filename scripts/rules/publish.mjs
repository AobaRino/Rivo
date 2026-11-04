import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { collectTags, repositoryRoot } from './generate.mjs'

const exec = promisify(execFile)
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

export async function validateArtifacts(output) {
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
  if (
    manifest.schemaVersion !== 1 ||
    manifest.generator?.repository !== 'AobaRino/Rivo' ||
    !/^[a-f0-9]{40}$/.test(manifest.upstream?.commit || '') ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== manifest.totalFiles
  )
    throw new Error('Invalid publication manifest')
  const catalog = JSON.parse(await readFile(join(output, 'catalog.json'), 'utf8'))
  const tags = collectTags(catalog)
  if (
    sha256(JSON.stringify(catalog)) !== manifest.catalogSha256 ||
    tags.length !== manifest.totalFiles
  )
    throw new Error('Publication catalog mismatch')
  const allowed = new Set([
    'README.md',
    'manifest.json',
    'catalog.json',
    'SOURCES.md',
    'LICENSE.MetaCubeX',
  ])
  for (const entry of manifest.files) {
    if (
      !/^geosite\/[a-z0-9][a-z0-9@!_-]*\.list$/.test(entry.path) ||
      entry.path !== `geosite/${entry.tag}.list` ||
      !tags.includes(entry.tag) ||
      allowed.has(entry.path)
    )
      throw new Error('Invalid or duplicate artifact path')
    allowed.add(entry.path)
    if (sha256(await readFile(join(output, entry.path))) !== entry.sha256)
      throw new Error(`Hash mismatch: ${entry.path}`)
  }
  if (sha256(await readFile(join(output, 'LICENSE.MetaCubeX'))) !== manifest.license?.sha256)
    throw new Error('License hash mismatch')
  if (
    manifest.files.some((entry) => !Number.isSafeInteger(entry.rules) || entry.rules < 0) ||
    manifest.files.reduce((sum, entry) => sum + entry.rules, 0) !== manifest.totalRules
  )
    throw new Error('Publication rule count mismatch')
  const actual = []
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`
      if (entry.isDirectory()) {
        if (path !== 'geosite') throw new Error(`Unexpected artifact directory: ${path}`)
        await walk(join(directory, entry.name), `${path}/`)
      } else if (entry.isFile()) actual.push(path)
      else throw new Error(`Unexpected artifact type: ${path}`)
    }
  }
  await walk(output)
  if (actual.length !== allowed.size || actual.some((path) => !allowed.has(path)))
    throw new Error('Missing or unexpected publication files')
  return manifest
}

// An isolated Git index builds one tree without changing the source branch/worktree.
// The normal non-forced push is an atomic ref update; a concurrent writer causes failure.
export async function publishArtifacts({ output, repository = repositoryRoot, remote = 'origin' }) {
  output = resolve(output)
  const manifest = await validateArtifacts(output)
  const git = async (args, options = {}) =>
    (await exec('git', args, { cwd: repository, ...options })).stdout.trim()
  let parent = null
  try {
    await git(['ls-remote', '--exit-code', remote, 'refs/heads/rules'])
    await git(['fetch', '--no-tags', remote, 'refs/heads/rules'])
    parent = await git(['rev-parse', 'FETCH_HEAD'])
  } catch (error) {
    if (error.code !== 2) throw error
  }
  const gitDirectory = await git(['rev-parse', '--absolute-git-dir'])
  const scratch = await mkdtemp(join(tmpdir(), 'rivo-rules-index-'))
  const env = {
    ...process.env,
    GIT_INDEX_FILE: join(scratch, 'index'),
    GIT_AUTHOR_NAME: 'github-actions[bot]',
    GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'github-actions[bot]',
    GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
  }
  try {
    const args = ['--git-dir', gitDirectory, '--work-tree', output, '-c', 'core.autocrlf=false']
    await git([...args, 'read-tree', '--empty'], { env, cwd: output })
    await git([...args, 'add', '-A', '--', '.'], { env, cwd: output })
    const tree = await git([...args, 'write-tree'], { env, cwd: output })
    const message = `Update rule supplements from MetaCubeX ${manifest.upstream.commit}\n\n${manifest.totalFiles} files; ${manifest.totalRules} rules; generated ${manifest.generatedAt}`
    const commit = await git(
      ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message],
      { env },
    )
    await git(['push', remote, `${commit}:refs/heads/rules`])
    return { commit, parent, upstream: manifest.upstream.commit }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== '--output') {
    console.error('Usage: node scripts/rules/publish.mjs --output generated-directory')
    process.exitCode = 1
  } else {
    publishArtifacts({ output: process.argv[3] })
      .then((result) => console.log(JSON.stringify(result, null, 2)))
      .catch((error) => {
        console.error(error)
        process.exitCode = 1
      })
  }
}
