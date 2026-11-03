import { afterEach, describe, expect, it, vi } from 'vitest'
import upstream from '../vendor/meta-json-schema/schema.json'
import { correctedSchema, getSchemaSnapshot, refreshCoreSchema } from './schemaStore'
import { editorSchemas } from './yamlSchema'
import { schemaVersion, sectionSchema } from './mihomoSchema'
import type { JSONSchema } from 'monaco-yaml'

afterEach(() => vi.unstubAllGlobals())
describe('core-linked schemas', () => {
  it('follows the committed bundle, rolls back and preserves fallback version warnings', async () => {
    const raw = structuredClone(upstream) as unknown as JSONSchema
    raw.definitions!.general = {
      type: 'object',
      properties: { 'sandbox-marker': { type: 'boolean' } },
    }
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    for (const next of [
      { id: 'core32', version: '1.19.32', coreVersion: 'v1.19.32', warning: '', schema: raw },
      { id: 'core31', version: '1.19.31', coreVersion: 'v1.19.31', warning: '', schema: upstream },
      {
        id: 'core33',
        version: '1.19.31',
        coreVersion: 'v1.19.33',
        warning: '保留旧版',
        schema: upstream,
      },
    ]) {
      fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ current: { id: next.id } }) })
      fetch.mockResolvedValueOnce({ ok: true, json: async () => next })
      await refreshCoreSchema()
      expect(getSchemaSnapshot().version).toBe(next.version)
      expect(schemaVersion).toBe(next.version)
      expect(getSchemaSnapshot().warning).toBe(next.warning)
      expect(editorSchemas(getSchemaSnapshot())[0].uri).toContain(next.id)
      if (next.id === 'core32')
        expect(sectionSchema('general').properties).toHaveProperty('sandbox-marker')
    }
    fetch.mockRejectedValueOnce(new Error('offline'))
    await refreshCoreSchema()
    expect(getSchemaSnapshot().id).toBe('core33')
    expect(getSchemaSnapshot().warning).toContain('同步失败')
  })
  it('does not mutate upstream schema or apply version-specific corrections to another version', () => {
    const original = JSON.stringify(upstream)
    const current = correctedSchema(upstream as unknown as JSONSchema, '1.19.32')
    const older = correctedSchema(upstream as unknown as JSONSchema, '1.19.31')
    expect(JSON.stringify(upstream)).toBe(original)
    expect(current).not.toEqual(older)
  })
})
