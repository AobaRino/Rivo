import { useEffect, useSyncExternalStore } from 'react'
import { apiFetch } from './transport'
import type { JSONSchema } from 'monaco-yaml'
import upstream from '../vendor/meta-json-schema/schema.json'
import overrides from '../vendor/meta-json-schema/overrides.json'

export type SchemaSnapshot = {
  id: string
  version: string
  coreVersion: string
  warning: string
  schema: JSONSchema
}

export function correctedSchema(raw: JSONSchema, version: string): JSONSchema {
  const schema = structuredClone(raw)
  // Corrections were audited against this exact version, not future schemas.
  if (version === '1.19.32') {
    const variants = (schema.definitions!.proxies.items as JSONSchema).anyOf as JSONSchema[]
    for (const variant of variants) {
      const type = ((variant.allOf![0] as JSONSchema).properties!.type as JSONSchema).const
      const extra = (overrides as Record<string, JSONSchema['properties']>)[String(type)]
      if (extra) variant.allOf!.push({ properties: extra })
    }
  }
  return schema
}

let snapshot: SchemaSnapshot = {
  id: 'bundled',
  version: '1.19.32',
  coreVersion: '',
  warning: '',
  schema: correctedSchema(upstream as unknown as JSONSchema, '1.19.32'),
}
const listeners = new Set<() => void>()
export const getSchemaSnapshot = () => snapshot
export function subscribeSchema(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const useSchemaSnapshot = () => useSyncExternalStore(subscribeSchema, getSchemaSnapshot)

let pending: Promise<void> | undefined
export function refreshCoreSchema(): Promise<void> {
  if (pending) return pending
  pending = (async () => {
    try {
      const statusResponse = await apiFetch('/api/core', { signal: AbortSignal.timeout(10000) })
      if (!statusResponse.ok) throw new Error('无法读取内核版本')
      const status = await statusResponse.json()
      const expected = status.current?.id || 'bundled'
      if (expected === snapshot.id && !snapshot.warning.startsWith('同步失败')) return
      const response = await apiFetch('/api/core/schema', { signal: AbortSignal.timeout(10000) })
      if (!response.ok) throw new Error('无法读取匹配的 Schema')
      const next = (await response.json()) as SchemaSnapshot
      if (next.id !== expected) return
      if (!next.schema?.definitions?.proxies?.items || !next.schema.allOf)
        throw new Error('Schema 结构无效')
      snapshot = { ...next, schema: correctedSchema(next.schema, next.version) }
      listeners.forEach((listener) => listener())
    } catch {
      if (!snapshot.warning.startsWith('同步失败')) {
        snapshot = { ...snapshot, warning: '同步失败：暂时使用已加载的 Schema，内核版本状态待确认' }
        listeners.forEach((listener) => listener())
      }
    }
  })().finally(() => {
    pending = undefined
  })
  return pending
}

export function useSchemaSync() {
  useEffect(() => {
    void refreshCoreSchema()
    const timer = window.setInterval(() => {
      void refreshCoreSchema()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [])
}
