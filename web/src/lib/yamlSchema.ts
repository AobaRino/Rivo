import type { JSONSchema } from 'monaco-yaml'
import type { SchemaSnapshot } from './schemaStore'

// Monaco displays markdownDescription in both completion details and hover.
// Some upstream fields only have a Chinese title, so include it in the help.
function describe(value: unknown): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach(describe)
    return
  }
  const node = value as JSONSchema
  const description = node.markdownDescription || node.description
  if (node.title) {
    node.markdownDescription =
      description && description !== node.title ? `**${node.title}**\n\n${description}` : node.title
  }
  Object.values(value).forEach(describe)
}
export function editorSchemas(snapshot: SchemaSnapshot) {
  const config = structuredClone(snapshot.schema)
  describe(config)
  // Distinct IDs prevent resolved schema caches leaking across a rollback.
  const prefix = `https://rivo.invalid/schemas/${snapshot.id}`
  const configSchema: JSONSchema = { ...config, $id: `${prefix}/config.json` }
  const proxySchema: JSONSchema = {
    $schema: config.$schema,
    $id: `${prefix}/proxy.json`,
    type: 'object',
    ...(config.definitions!.proxies.items as JSONSchema),
    definitions: config.definitions,
  }
  return [
    { uri: configSchema.$id!, fileMatch: ['**/config-*.yaml'], schema: configSchema },
    { uri: proxySchema.$id!, fileMatch: ['**/proxy-*.yaml'], schema: proxySchema },
  ]
}
