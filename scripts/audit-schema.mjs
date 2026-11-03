import fs from 'node:fs'
import path from 'node:path'

// Read-only audit against a pinned Mihomo checkout. No upstream code is executed.
const root = process.argv[2]
if (!root) throw new Error('Usage: node scripts/audit-schema.mjs <mihomo-checkout>')
const schema = JSON.parse(fs.readFileSync('web/src/vendor/meta-json-schema/schema.json', 'utf8'))
const overrides = JSON.parse(
  fs.readFileSync('web/src/vendor/meta-json-schema/overrides.json', 'utf8'),
)
const resolve = (ref) =>
  ref
    .slice(2)
    .split('/')
    .reduce((o, k) => o[k.replace(/~1/g, '/').replace(/~0/g, '~')], schema)
function fields(s, seen = new Set()) {
  let result = new Set(Object.keys(s.properties || {}))
  if (s.$ref && !seen.has(s.$ref)) {
    const next = new Set(seen).add(s.$ref)
    for (const field of fields(resolve(s.$ref), next)) result.add(field)
  }
  for (const child of [...(s.allOf || []), s.then, s.else].filter(Boolean))
    for (const field of fields(child, seen)) result.add(field)
  return result
}
const structs = new Map()
for (const file of fs
  .readdirSync(path.join(root, 'adapter/outbound'))
  .filter((f) => f.endsWith('.go'))) {
  const source = fs.readFileSync(path.join(root, 'adapter/outbound', file), 'utf8')
  for (const match of source.matchAll(/^type (\w+) struct \{([\s\S]*?)^\}/gm))
    structs.set(match[1], match[2])
}
function options(name, seen = new Set()) {
  if (seen.has(name)) return []
  seen.add(name)
  const body = structs.get(name) || ''
  const direct = [...body.matchAll(/proxy:"([^",]+)(?:,[^"]*)?"/g)]
    .map((m) => m[1])
    .filter((x) => x !== '-')
  const embedded = [...body.matchAll(/^\s+\*?(\w+)\s*$/gm)].flatMap((m) => options(m[1], seen))
  return [...new Set([...direct, ...embedded])]
}
const parser = fs.readFileSync(path.join(root, 'adapter/parser.go'), 'utf8')
const report = []
for (const match of parser.matchAll(/case "([^"]+)":([\s\S]*?)(?=\n\tcase |\n\tdefault:)/g)) {
  const type = match[1]
  const struct = match[2].match(/&outbound\.(\w+)\{/)
  if (!struct) throw new Error(`Cannot locate options for ${type}`)
  const variant = schema.definitions.proxies.items.anyOf.find(
    (v) => v.allOf[0].properties.type.const === type,
  )
  const catalog = variant ? fields(variant) : new Set()
  for (const key of Object.keys(overrides[type] || {})) catalog.add(key)
  const core = options(struct[1])
  report.push({
    type,
    coreFields: core.length,
    schemaFields: catalog.size,
    missing: core.filter((k) => !catalog.has(k)),
  })
}
console.log(
  JSON.stringify(
    {
      coreTypes: report.length,
      missingTypes: report.filter((r) => !r.schemaFields).map((r) => r.type),
      protocols: report,
    },
    null,
    2,
  ),
)
if (report.some((r) => r.missing.length || !r.schemaFields)) process.exitCode = 1
