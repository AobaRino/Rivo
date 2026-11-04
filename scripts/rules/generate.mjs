import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const generatorVersion = 1
const acceptedTypes = new Set(['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD', 'DOMAIN-REGEX'])
const selectedTypes = new Set(['DOMAIN-KEYWORD', 'DOMAIN-REGEX'])
const shaPattern = /^[a-f0-9]{40}$/
const tagPattern = /^[a-z0-9][a-z0-9@!_-]*$/
const hash = (text) => createHash('sha256').update(text).digest('hex')

export function collectTags(catalog) {
  if (
    catalog?.schemaVersion !== 1 ||
    catalog.upstream?.repository !== 'MetaCubeX/meta-rules-dat' ||
    catalog.upstream?.ref !== 'meta'
  )
    throw new Error('Unsupported catalog or upstream')
  if (
    !Array.isArray(catalog.baseDomains) ||
    !catalog.baseDomains.length ||
    !catalog.services ||
    typeof catalog.services !== 'object' ||
    Array.isArray(catalog.services)
  )
    throw new Error('Catalog must define baseDomains and services')
  const tags = [...catalog.baseDomains]
  for (const [id, service] of Object.entries(catalog.services)) {
    if (!tagPattern.test(id) || !Array.isArray(service?.domains) || !service.domains.length)
      throw new Error(`Invalid service: ${id}`)
    for (const key of Object.keys(service)) {
      if (!['domains', 'directDomains', 'ips'].includes(key) || !Array.isArray(service[key]))
        throw new Error(`Invalid catalog field: ${id}.${key}`)
      for (const tag of service[key]) {
        if (
          typeof tag !== 'string' ||
          !tagPattern.test(tag) ||
          /(^|[-_])ads?($|[-_])|advertis|malware|phishing/i.test(tag)
        )
          throw new Error(`Invalid or excluded category: ${tag}`)
      }
    }
    tags.push(...service.domains, ...(service.directDomains || []))
  }
  for (const tag of tags) {
    if (
      typeof tag !== 'string' ||
      !tagPattern.test(tag) ||
      /(^|[-_])ads?($|[-_])|advertis|malware|phishing/i.test(tag)
    )
      throw new Error(`Invalid or excluded category: ${tag}`)
  }
  return [...new Set(tags)].sort()
}

// Split only at the FIRST comma: regex quantifiers such as {1,3} are payload.
export function extractSupplement(text, source = 'input') {
  const rules = []
  const seen = new Set()
  const counts = { DOMAIN: 0, 'DOMAIN-SUFFIX': 0, 'DOMAIN-KEYWORD': 0, 'DOMAIN-REGEX': 0 }
  let sourceRules = 0
  for (const [index, raw] of text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .entries()) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const comma = line.indexOf(',')
    const type = line.slice(0, comma)
    const payload = line.slice(comma + 1)
    if (
      comma < 1 ||
      !acceptedTypes.has(type) ||
      !payload ||
      payload !== payload.trim() ||
      /[\x00-\x1f\x7f]/.test(payload)
    )
      throw new Error(`${source}:${index + 1}: unknown or malformed classical rule`)
    // Domain lists may not contain outbound policies/options. Regex commas are legal.
    if (type !== 'DOMAIN-REGEX' && payload.includes(','))
      throw new Error(`${source}:${index + 1}: unexpected extra rule arguments`)
    sourceRules++
    counts[type]++
    if (selectedTypes.has(type) && !seen.has(line)) {
      seen.add(line)
      rules.push(line)
    }
  }
  if (!sourceRules) throw new Error(`${source}: upstream is empty or not a classical list`)
  return {
    rules,
    sourceRules,
    sourceCounts: counts,
    counts: Object.fromEntries(
      [...selectedTypes].map((type) => [
        type,
        rules.filter((line) => line.startsWith(`${type},`)).length,
      ]),
    ),
  }
}

export async function downloadText(
  url,
  {
    fetchImpl = fetch,
    attempts = 3,
    timeoutMs = 30_000,
    maxBytes = 20 * 1024 * 1024,
    token = process.env.GITHUB_TOKEN,
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  } = {},
) {
  const address = new URL(url)
  if (
    address.protocol !== 'https:' ||
    !['api.github.com', 'raw.githubusercontent.com'].includes(address.hostname)
  )
    throw new Error('Only official GitHub HTTPS sources are allowed')
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('Download timeout')), timeoutMs)
    try {
      const headers = { 'User-Agent': 'Rivo-rule-supplements/1' }
      if (address.hostname === 'api.github.com') {
        headers.Accept = 'application/vnd.github+json'
        if (token) headers.Authorization = `Bearer ${token}`
      }
      const response = await fetchImpl(url, {
        headers,
        signal: controller.signal,
        redirect: 'error',
      })
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} for ${address.pathname}`)
        error.permanent = response.status < 500 && ![408, 429].includes(response.status)
        throw error
      }
      if (Number(response.headers.get('content-length')) > maxBytes)
        throw new Error('Response is too large')
      if (!response.body) throw new Error('Response has no body')
      const reader = response.body.getReader()
      const chunks = []
      let size = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > maxBytes) throw new Error('Response is too large')
          chunks.push(Buffer.from(value))
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    } catch (error) {
      lastError = error
      if (error.permanent || attempt === attempts) break
      await sleep(500 * 2 ** (attempt - 1))
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`Download failed after at most ${attempts} attempts: ${url}`, {
    cause: lastError,
  })
}

export async function generateArtifacts({
  catalog,
  upstreamSha,
  download = downloadText,
  generatedAt = new Date().toISOString(),
  generatorCommit = process.env.GITHUB_SHA || null,
  licenseText,
  noticesText,
}) {
  const tags = collectTags(catalog)
  if (!licenseText?.includes('GNU GENERAL PUBLIC LICENSE') || !noticesText?.includes('MetaCubeX'))
    throw new Error('Upstream license and attribution are required')
  const repo = catalog.upstream.repository
  let upstreamCommittedAt = null
  if (!upstreamSha) {
    const commit = JSON.parse(
      await download(`https://api.github.com/repos/${repo}/commits/${catalog.upstream.ref}`),
    )
    upstreamSha = commit.sha
    upstreamCommittedAt = commit.commit?.committer?.date || null
  }
  if (!shaPattern.test(upstreamSha))
    throw new Error('Upstream revision must be a complete commit SHA')
  if (!Number.isFinite(Date.parse(generatedAt))) throw new Error('Invalid generation time')
  const files = new Map()
  const entries = []
  // Bounded workers; nothing touches the output directory until ALL downloads validate.
  let cursor = 0
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(4, tags.length) }, async () => {
      while (cursor < tags.length) {
        const tag = tags[cursor++]
        const sourceURL = `https://raw.githubusercontent.com/${repo}/${upstreamSha}/geo/geosite/classical/${tag}.list`
        const source = await download(sourceURL)
        const parsed = extractSupplement(source, tag)
        const path = `geosite/${tag}.list`
        const text = [
          '# Rivo keyword / regex supplement; use with the matching MetaCubeX domain MRS.',
          `# Source: ${sourceURL}`,
          `# Modified: ${generatedAt}; kept DOMAIN-KEYWORD / DOMAIN-REGEX only.`,
          '# License: GPL-3.0; see LICENSE.MetaCubeX and SOURCES.md.',
          `# Rules: ${parsed.rules.length}`,
          ...parsed.rules,
          '',
        ].join('\n')
        files.set(path, text)
        entries.push({
          tag,
          path,
          sourceURL,
          sourceSha256: hash(source),
          sha256: hash(text),
          sourceRules: parsed.sourceRules,
          sourceCounts: parsed.sourceCounts,
          rules: parsed.rules.length,
          counts: parsed.counts,
        })
      }
    }),
  )
  const failures = results.filter((result) => result.status === 'rejected')
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      'No artifacts published: one or more source files failed',
    )
  entries.sort((a, b) => a.tag.localeCompare(b.tag, 'en'))
  const manifest = {
    schemaVersion: 1,
    generatedAt,
    generator: { version: generatorVersion, repository: 'AobaRino/Rivo', commit: generatorCommit },
    upstream: {
      repository: repo,
      ref: catalog.upstream.ref,
      commit: upstreamSha,
      committedAt: upstreamCommittedAt,
    },
    catalogSha256: hash(JSON.stringify(catalog)),
    license: { file: 'LICENSE.MetaCubeX', sha256: hash(licenseText) },
    totalFiles: entries.length,
    totalRules: entries.reduce((sum, entry) => sum + entry.rules, 0),
    files: entries,
  }
  files.set('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`)
  files.set('catalog.json', `${JSON.stringify(catalog, null, 2)}\n`)
  files.set('LICENSE.MetaCubeX', licenseText)
  files.set('SOURCES.md', noticesText)
  files.set(
    'README.md',
    `# Rivo rule supplements\n\nGenerated at ${generatedAt} from [MetaCubeX/meta-rules-dat@${upstreamSha}](https://github.com/${repo}/commit/${upstreamSha}).\n\n${entries.length} files / ${manifest.totalRules} keyword and regex rules. Files with zero rules intentionally contain comments only. No advertising category is selected.\n\nUse \`behavior: classical\`, \`format: text\`, \`interval: 86400\`. Keep the matching upstream MRS provider; these files are supplements, not replacements.\n\nSee [manifest.json](manifest.json) for counts and hashes and [SOURCES.md](SOURCES.md) for source and license notices. Generator: [scripts/rules](https://github.com/AobaRino/Rivo/tree/${generatorCommit || 'main'}/scripts/rules).\n`,
  )
  return { files, manifest }
}

export async function writeArtifacts(output, files) {
  const destination = resolve(output)
  const parent = dirname(destination)
  await mkdir(parent, { recursive: true })
  const existing = await stat(destination).catch((error) => {
    if (error.code !== 'ENOENT') throw error
  })
  if (existing && !existing.isDirectory()) throw new Error('Output is not a directory')
  if (existing) {
    const previous = JSON.parse(
      await readFile(join(destination, 'manifest.json'), 'utf8').catch(() => 'null'),
    )
    if (previous?.generator?.repository !== 'AobaRino/Rivo')
      throw new Error('Refusing to replace a directory not generated by Rivo rules')
  }
  const stage = await mkdtemp(join(parent, '.rivo-rules-stage-'))
  let backup
  try {
    for (const [path, text] of files) {
      const target = resolve(stage, path)
      const rel = relative(stage, target)
      if (
        isAbsolute(rel) ||
        rel === '..' ||
        rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
      )
        throw new Error('Unsafe output path')
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, text, 'utf8')
    }
    if (existing) {
      backup = `${stage}-previous`
      await rename(destination, backup)
    }
    try {
      await rename(stage, destination)
    } catch (error) {
      if (backup) await rename(backup, destination)
      throw error
    }
    if (backup) await rm(backup, { recursive: true, force: true })
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

async function main() {
  const args = process.argv.slice(2)
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!['--output', '--upstream-sha'].includes(args[i]) || !args[i + 1])
      throw new Error(
        'Usage: node scripts/rules/generate.mjs [--output directory] [--upstream-sha full-sha]',
      )
    options[args[i]] = args[i + 1]
  }
  const [catalogText, licenseText, noticesText] = await Promise.all(
    ['catalog.json', 'LICENSE.MetaCubeX', 'SOURCES.md'].map((name) =>
      readFile(join(repositoryRoot, 'rules', name), 'utf8'),
    ),
  )
  const generated = await generateArtifacts({
    catalog: JSON.parse(catalogText),
    upstreamSha: options['--upstream-sha'],
    licenseText,
    noticesText,
  })
  const output = resolve(options['--output'] || join(repositoryRoot, '.local/rules-output'))
  await writeArtifacts(output, generated.files)
  console.log(
    JSON.stringify(
      {
        output,
        upstream: generated.manifest.upstream,
        files: generated.manifest.totalFiles,
        rules: generated.manifest.totalRules,
      },
      null,
      2,
    ),
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
