import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  collectTags,
  downloadText,
  extractSupplement,
  generateArtifacts,
  repositoryRoot,
  writeArtifacts,
} from './generate.mjs'

const sha = 'a'.repeat(40)
const catalog = {
  schemaVersion: 1,
  upstream: { repository: 'MetaCubeX/meta-rules-dat', ref: 'meta' },
  baseDomains: ['private'],
  services: { steam: { domains: ['steam'], directDomains: ['steam@cn'], ips: ['steam-ip'] } },
}
const licenseText = 'GNU GENERAL PUBLIC LICENSE\nVersion 3\n'
const noticesText = 'Source: MetaCubeX/meta-rules-dat\n'
const options = {
  catalog,
  licenseText,
  noticesText,
  upstreamSha: sha,
  generatedAt: '2026-11-04T00:00:00.000Z',
}
const source =
  'DOMAIN,example.com\nDOMAIN-SUFFIX,example.org\nDOMAIN-KEYWORD,steam\nDOMAIN-REGEX,^foo[0-9]{1,3}\\.example$\n'

test('shared catalog covers every domain category without IP or advertising sets', async () => {
  const real = JSON.parse(await readFile(join(repositoryRoot, 'rules/catalog.json'), 'utf8'))
  const tags = collectTags(real)
  assert.equal(Object.keys(real.services).length, 23)
  assert.equal(tags.length, 32)
  assert.ok(tags.includes('private') && tags.includes('cn') && tags.includes('geolocation-!cn'))
  assert.ok(tags.includes('steam@cn') && tags.includes('category-game-platforms-download'))
  assert.deepEqual(collectTags(catalog), ['private', 'steam', 'steam@cn'])
  for (const tag of ['../escape', 'category-ads-all', 'advertising', 'bad/name']) {
    assert.throws(() => collectTags({ ...catalog, baseDomains: [tag] }), /Invalid or excluded/)
  }
})

test('retains exact keyword/regex lines, commas and escapes, deduplicating in source order', () => {
  const parsed = extractSupplement(`\uFEFF# source\r\n${source}DOMAIN-KEYWORD,steam\n`)
  assert.deepEqual(parsed.rules, ['DOMAIN-KEYWORD,steam', 'DOMAIN-REGEX,^foo[0-9]{1,3}\\.example$'])
  assert.equal(parsed.sourceRules, 5)
  assert.deepEqual(parsed.counts, { 'DOMAIN-KEYWORD': 1, 'DOMAIN-REGEX': 1 })
  assert.equal(parsed.sourceCounts['DOMAIN-KEYWORD'], 2)
  assert.deepEqual(extractSupplement('DOMAIN,a.example\n').rules, [])
})

test('fails closed on new types, HTML, empty input and malformed rules', () => {
  for (const text of [
    'DOMAIN-WILDCARD,*.test',
    'IP-CIDR,1.2.3.4/32',
    '<html>Error</html>',
    '# nothing',
    '',
    'DOMAIN-KEYWORD,',
    'DOMAIN,x,DIRECT',
    'DOMAIN-KEYWORD,x,REJECT',
    'DOMAIN-SUFFIX, x',
    'DOMAIN-REGEX,a\u0000b',
  ])
    assert.throws(() => extractSupplement(text), /unknown|malformed|empty|arguments/)
})

test('resolves branch once and pins every source to that SHA, including empty supplements', async () => {
  const calls = []
  const result = await generateArtifacts({
    ...options,
    upstreamSha: undefined,
    download: async (url) => {
      calls.push(url)
      if (url.startsWith('https://api.github.com/'))
        return JSON.stringify({ sha, commit: { committer: { date: '2026-11-03T23:00:00Z' } } })
      return url.endsWith('/private.list') ? 'DOMAIN,localhost\n' : source
    },
  })
  assert.equal(calls.filter((url) => url.startsWith('https://api.github.com/')).length, 1)
  assert.ok(calls.slice(1).every((url) => url.includes(`/${sha}/geo/geosite/classical/`)))
  assert.equal(result.manifest.totalFiles, 3)
  assert.equal(result.manifest.totalRules, 4)
  assert.equal(result.manifest.upstream.committedAt, '2026-11-03T23:00:00Z')
  assert.equal(result.manifest.files.find((entry) => entry.tag === 'private').rules, 0)
  assert.ok(
    result.files
      .get('geosite/private.list')
      .trim()
      .split('\n')
      .every((line) => line.startsWith('#')),
  )
  assert.ok(
    result.manifest.files.every(
      (entry) => /^[a-f0-9]{64}$/.test(entry.sha256) && entry.sourceCounts.DOMAIN > 0,
    ),
  )
  const again = await generateArtifacts({ ...options, download: async () => source })
  const repeated = await generateArtifacts({ ...options, download: async () => source })
  assert.deepEqual(again, repeated)
})

test('rejects non-SHA refs and unknown upstream rules without returning a partial batch', async () => {
  await assert.rejects(
    generateArtifacts({ ...options, upstreamSha: 'meta' }),
    /complete commit SHA/,
  )
  await assert.rejects(
    generateArtifacts({
      ...options,
      download: async (url) => (url.endsWith('steam.list') ? 'NEW-TYPE,x' : source),
    }),
    AggregateError,
  )
  await assert.rejects(
    generateArtifacts({
      ...options,
      download: async () => {
        throw new Error('offline')
      },
    }),
    AggregateError,
  )
})

test('network retries transient failures and never leaks API authentication to Raw', async () => {
  let calls = 0
  let rawHeaders
  assert.equal(
    await downloadText('https://raw.githubusercontent.com/owner/repo/sha/file', {
      sleep: async () => {},
      token: 'test-only-token',
      fetchImpl: async (_, init) => {
        rawHeaders = init.headers
        calls++
        return new Response(calls < 3 ? 'unavailable' : 'ok', { status: calls < 3 ? 503 : 200 })
      },
    }),
    'ok',
  )
  assert.equal(calls, 3)
  assert.equal(rawHeaders.Authorization, undefined)
  let apiHeaders
  await downloadText('https://api.github.com/repos/a/b/commits/meta', {
    token: 'test-only-token',
    fetchImpl: async (_, init) => {
      apiHeaders = init.headers
      return new Response('{}')
    },
  })
  assert.equal(apiHeaders.Authorization, 'Bearer test-only-token')
  calls = 0
  await assert.rejects(
    downloadText('https://raw.githubusercontent.com/a/b/missing', {
      sleep: async () => {},
      fetchImpl: async () => {
        calls++
        return new Response('missing', { status: 404 })
      },
    }),
    /Download failed/,
  )
  assert.equal(calls, 1)
})

test('download bounds body size and elapsed time', async () => {
  await assert.rejects(downloadText('https://example.com/file'), /Only official/)
  await assert.rejects(
    downloadText('https://raw.githubusercontent.com/a/b/file', {
      attempts: 1,
      maxBytes: 3,
      fetchImpl: async () => new Response('toolarge'),
    }),
    /Download failed/,
  )
  await assert.rejects(
    downloadText('https://raw.githubusercontent.com/a/b/file', {
      attempts: 1,
      timeoutMs: 10,
      fetchImpl: async (_, { signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        ),
    }),
    /Download failed/,
  )
})

test('whole batch replacement preserves previous output on generation failure and rejects unrelated directories', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rivo-rule-generate-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const output = join(directory, 'output')
  const generated = await generateArtifacts({ ...options, download: async () => source })
  await writeArtifacts(output, generated.files)
  const before = await readFile(join(output, 'manifest.json'), 'utf8')
  await assert.rejects(
    generateArtifacts({ ...options, download: async () => '<html>bad</html>' }),
    AggregateError,
  )
  assert.equal(await readFile(join(output, 'manifest.json'), 'utf8'), before)
  await writeFile(join(output, 'stale.list'), 'stale')
  await writeArtifacts(output, generated.files)
  await assert.rejects(readFile(join(output, 'stale.list')), { code: 'ENOENT' })
  await assert.rejects(writeArtifacts(directory, generated.files), /Refusing/)
  await assert.rejects(
    writeArtifacts(join(directory, 'unsafe'), new Map([['../escape', 'oops']])),
    /Unsafe output path/,
  )
})
