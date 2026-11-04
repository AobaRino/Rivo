import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { generateArtifacts, writeArtifacts } from './generate.mjs'
import { publishArtifacts, validateArtifacts } from './publish.mjs'

const exec = promisify(execFile)

test('one atomic rules branch commit leaves main/worktree/index unchanged; invalid batch cannot publish', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rivo-rule-publish-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const repository = join(directory, 'source')
  const remote = join(directory, 'remote.git')
  const output = join(directory, 'output')
  await mkdir(repository)
  const git = async (args, cwd = repository) => (await exec('git', args, { cwd })).stdout.trim()
  await git(['init', '--bare', remote])
  await git(['init', '--initial-branch=main'])
  await git(['config', 'user.name', 'Rivo test'])
  await git(['config', 'user.email', 'test@example.invalid'])
  await git(['config', 'core.autocrlf', 'false'])
  await git(['remote', 'add', 'origin', remote])
  await writeFile(join(repository, 'source.txt'), 'main\n')
  await git(['add', '.'])
  await git(['commit', '-m', 'source'])
  await git(['push', 'origin', 'main'])
  const main = await git(['rev-parse', 'HEAD'])
  await writeFile(join(repository, 'source.txt'), 'user edit\n')
  await git(['add', 'source.txt'])
  const index = await git(['write-tree'])
  const status = await git(['status', '--porcelain'])
  const options = {
    catalog: {
      schemaVersion: 1,
      upstream: { repository: 'MetaCubeX/meta-rules-dat', ref: 'meta' },
      baseDomains: ['private'],
      services: {},
    },
    upstreamSha: 'b'.repeat(40),
    generatedAt: '2026-11-04T00:00:00Z',
    licenseText: 'GNU GENERAL PUBLIC LICENSE',
    noticesText: 'MetaCubeX',
    download: async () => 'DOMAIN-SUFFIX,example.com\nDOMAIN-KEYWORD,steam\n',
  }
  const generated = await generateArtifacts(options)
  await writeArtifacts(output, generated.files)
  const first = await publishArtifacts({ repository, output })
  assert.equal(first.parent, null)
  assert.equal(await git(['rev-parse', 'HEAD']), main)
  assert.equal(await git(['write-tree']), index)
  assert.equal(await git(['status', '--porcelain']), status)
  assert.equal(await readFile(join(repository, 'source.txt'), 'utf8'), 'user edit\n')
  assert.equal(await git(['rev-parse', 'refs/heads/main'], remote), main)
  assert.equal(await git(['rev-parse', 'refs/heads/rules'], remote), first.commit)
  assert.equal(await git(['rev-list', '--count', 'rules'], remote), '1')
  const published = (await git(['ls-tree', '-r', '--name-only', 'rules'], remote)).split('\n')
  assert.ok(published.includes('geosite/private.list') && published.includes('manifest.json'))
  assert.ok(!published.includes('source.txt'))
  const secondBatch = await generateArtifacts({ ...options, generatedAt: '2026-11-05T00:00:00Z' })
  await writeArtifacts(output, secondBatch.files)
  const second = await publishArtifacts({ repository, output })
  assert.equal(second.parent, first.commit)
  assert.equal(await git(['rev-list', '--count', 'rules'], remote), '2')
  await writeFile(join(output, 'geosite/private.list'), 'tampered\n')
  await assert.rejects(publishArtifacts({ repository, output }), /Hash mismatch/)
  assert.equal(await git(['rev-parse', 'refs/heads/rules'], remote), second.commit)
  await writeArtifacts(output, secondBatch.files)
  await writeFile(join(output, 'unexpected.txt'), 'oops')
  await assert.rejects(validateArtifacts(output), /unexpected/)
  await writeArtifacts(output, secondBatch.files)
  await writeFile(
    join(output, 'catalog.json'),
    JSON.stringify({ ...options.catalog, baseDomains: ['cn'] }),
  )
  await assert.rejects(validateArtifacts(output), /catalog mismatch/)
  await writeArtifacts(output, secondBatch.files)
  // Linked worktrees have a .git FILE and their own index, not a .git directory.
  const linked = join(directory, 'linked-worktree')
  await git(['worktree', 'add', '-b', 'feature-rules', linked, 'HEAD'])
  const linkedIndex = await git(['write-tree'], linked)
  const third = await publishArtifacts({ repository: linked, output })
  assert.equal(third.parent, second.commit)
  assert.equal(await git(['rev-parse', 'HEAD'], linked), main)
  assert.equal(await git(['write-tree'], linked), linkedIndex)
  assert.equal(await git(['write-tree']), index)
  assert.equal(await git(['status', '--porcelain']), status)
})
