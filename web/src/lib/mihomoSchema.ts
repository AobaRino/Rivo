import Ajv from 'ajv'
import type { RJSFSchema, UiSchema } from '@rjsf/utils'
import { getSchemaSnapshot, subscribeSchema } from './schemaStore'

// Vendored unchanged from meta-json-schema 1.19.32 (MIT); see THIRD_PARTY_NOTICES.md.
export let schemaVersion = getSchemaSnapshot().version
export let schema = getSchemaSnapshot().schema as RJSFSchema
let definitions = schema.definitions!
const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true })
const validators = new Map<string, ReturnType<typeof ajv.compile>>()
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

export function resolveSchema(ref: string): RJSFSchema {
  if (!ref.startsWith('#/')) throw new Error('Only bundled local schema references are supported')
  return ref
    .slice(2)
    .split('/')
    .reduce<unknown>(
      (value, part) =>
        (value as Record<string, unknown>)[part.replace(/~1/g, '/').replace(/~0/g, '~')],
      schema,
    ) as RJSFSchema
}
const variants = (section: string) => (definitions[section] as RJSFSchema).items as RJSFSchema
const variantType = (s: RJSFSchema) =>
  String(
    (s.allOf?.[0] as RJSFSchema)?.properties?.type &&
      ((s.allOf![0] as RJSFSchema).properties!.type as RJSFSchema).const,
  )
export let protocolTypes = (variants('proxies').anyOf as RJSFSchema[]).map(variantType)
const unsubscribe = subscribeSchema(() => {
  const next = getSchemaSnapshot()
  if (next.schema === schema) return
  schemaVersion = next.version
  schema = next.schema as RJSFSchema
  definitions = schema.definitions!
  protocolTypes = (variants('proxies').anyOf as RJSFSchema[]).map(variantType)
  validators.clear()
  ajv.removeSchema()
})
if (import.meta.hot) import.meta.hot.dispose(unsubscribe)
export function protocolSchema(type: string): RJSFSchema | undefined {
  const original = (variants('proxies').anyOf as RJSFSchema[]).find((s) => variantType(s) === type)
  return original
}

function matches(condition: RJSFSchema, data: unknown): boolean {
  const key = JSON.stringify(condition)
  if (!validators.has(key)) validators.set(key, ajv.compile({ ...condition, definitions }))
  return !!validators.get(key)!(data)
}
function merge(a: RJSFSchema, b: RJSFSchema): RJSFSchema {
  const properties = { ...a.properties }
  for (const [key, value] of Object.entries(b.properties || {})) {
    const previous = properties[key]
    properties[key] =
      typeof previous === 'object' && typeof value === 'object' ? merge(previous, value) : value
  }
  return {
    ...a,
    ...b,
    ...(a.properties || b.properties ? { properties } : {}),
    ...(a.required || b.required
      ? { required: [...new Set([...(a.required || []), ...(b.required || [])])] }
      : {}),
  }
}

function optionalShape(input: RJSFSchema): RJSFSchema {
  const copy = { ...input }
  delete copy.required
  delete copy.const
  if (copy.properties)
    copy.properties = Object.fromEntries(
      Object.entries(copy.properties).map(([key, value]) => [
        key,
        typeof value === 'object' ? optionalShape(value) : value,
      ]),
    )
  return copy
}

/** Resolve composition for display. Inactive conditional fields remain discoverable;
 * validation always uses the original upstream schema, never this UI projection. */
export function fieldCatalog(
  input: RJSFSchema,
  data?: unknown,
  all = true,
  seen = new Set<string>(),
): RJSFSchema {
  let out: RJSFSchema = {}
  if (input.$ref && !seen.has(input.$ref)) {
    const next = new Set(seen).add(input.$ref)
    out = fieldCatalog(resolveSchema(input.$ref), data, all, next)
  }
  const {
    $ref: _ref,
    allOf,
    if: condition,
    then,
    else: otherwise,
    definitions: _defs,
    ...own
  } = input
  out = merge(out, own)
  for (const part of allOf || [])
    out = merge(out, fieldCatalog(part as RJSFSchema, data, all, seen))
  if (condition) {
    const active = matches(condition as RJSFSchema, data) ? then : otherwise
    if (all) {
      for (const branch of [then, otherwise]) {
        if (branch && typeof branch === 'object') {
          const fields = fieldCatalog(branch, data, all, seen)
          out = merge(out, { properties: optionalShape(fields).properties })
        }
      }
    }
    if (active && typeof active === 'object')
      out = merge(out, fieldCatalog(active, data, all, seen))
  }
  return out
}

function infer(value: unknown): RJSFSchema {
  if (isRecord(value))
    return {
      type: 'object',
      properties: Object.fromEntries(Object.entries(value).map(([k, v]) => [k, infer(v)])),
    }
  if (Array.isArray(value))
    return { type: 'array', items: value.length ? infer(value[0]) : { type: 'string' } }
  return {
    type:
      value === null
        ? 'null'
        : typeof value === 'number'
          ? 'number'
          : typeof value === 'boolean'
            ? 'boolean'
            : 'string',
  }
}

export function displaySchema(input: RJSFSchema, data?: unknown, depth = 0): RJSFSchema {
  if (depth > 32) return infer(data)
  const out = fieldCatalog(input, data)
  // Object unions in outbound definitions describe legal combinations (e.g. TLS
  // security modes), not separate copies of the node. Expose their fields once;
  // keep their constraints in the original schema validator.
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const choices = out[keyword]?.map((s) => fieldCatalog(s as RJSFSchema, data))
    if (
      choices?.length &&
      (out.type === 'object' ||
        out.properties ||
        choices.every((s) => s.properties || s.required || s.type === 'object'))
    ) {
      let combined = out
      for (const choice of choices)
        combined = merge(combined, { properties: optionalShape(choice).properties })
      out.properties = combined.properties
      out.type = 'object'
      delete out[keyword]
    }
  }
  delete out.default
  delete out.examples
  delete out.$id
  if (out.pattern && !out.type) out.type = 'string'
  // Upstream compatible primitives accept both Go weakly typed input and native YAML.
  // Prefer native controls for new values, keep the type of an imported scalar.
  if (
    out.anyOf?.length === 2 &&
    (out.anyOf[0] as RJSFSchema).type &&
    (out.anyOf[1] as RJSFSchema).pattern &&
    !(out.anyOf[1] as RJSFSchema).type
  ) {
    out.type = data == null ? (out.anyOf[0] as RJSFSchema).type : infer(data).type
    delete out.anyOf
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    if (out[keyword])
      out[keyword] = out[keyword]!.map((s) => {
        const choice = displaySchema(s as RJSFSchema, data, depth + 1)
        const names: Record<string, string> = {
          string: '文本',
          array: '列表',
          object: '对象',
          integer: '整数',
          number: '数值',
          boolean: '开关',
        }
        if (!choice.title && names[String(choice.type)]) choice.title = names[String(choice.type)]
        return choice
      })
  }
  if (
    out.anyOf?.length &&
    out.anyOf.every((s) =>
      ['string', 'integer', 'number', 'boolean'].includes(String((s as RJSFSchema).type)),
    )
  ) {
    const first = out.anyOf[0] as RJSFSchema
    out.type = data == null ? first.type : infer(data).type
    delete out.anyOf
  }
  if (out.enum && !out.type) out.type = infer(out.enum[0]).type
  if (out.properties || out.type === 'object') {
    out.type = 'object'
    const dictionary =
      !Object.keys(out.properties || {}).length || typeof out.additionalProperties === 'object'
    const current = isRecord(data) ? data : {}
    const properties = { ...out.properties }
    for (const [key, value] of Object.entries(current)) {
      if (!dictionary && !Object.hasOwn(properties, key)) properties[key] = infer(value)
    }
    out.properties = Object.fromEntries(
      Object.entries(properties).map(([key, child]) => {
        const s = displaySchema(child as RJSFSchema, current[key], depth + 1)
        s.title = s.title && s.title !== key ? `${key} · ${s.title}` : key
        return [key, s]
      }),
    )
    // Named options are added through our picker. Open dictionaries keep RJSF's key editor.
    out.additionalProperties = !dictionary
      ? false
      : typeof out.additionalProperties === 'object'
        ? displaySchema(out.additionalProperties, undefined, depth + 1)
        : true
    const additional = out.additionalProperties
    if (typeof additional === 'object' && (additional.anyOf || additional.oneOf)) {
      const first = (additional.anyOf || additional.oneOf)![0] as RJSFSchema
      // Used only by RJSF's explicit "add key" action. Automatic defaults stay disabled.
      // Otherwise RJSF initializes text/list unions as {}, shown as [object Object].
      if (first.type === 'string') additional.default = ''
      else if (first.type === 'array') additional.default = []
    }
  }
  if (out.items && !Array.isArray(out.items)) {
    out.items = displaySchema(
      out.items as RJSFSchema,
      Array.isArray(data) ? data[0] : undefined,
      depth + 1,
    )
  }
  if (!out.type && !out.anyOf && !out.oneOf && out.const === undefined)
    return { ...out, ...infer(data) }
  return out
}

export function uiSchemaFor(s: RJSFSchema): UiSchema {
  const ui: UiSchema = { 'ui:options': { label: true } }
  if (s.type === 'boolean') {
    ui['ui:widget'] = 'select'
    ui['ui:enumNames'] = ['开启', '关闭']
  }
  for (const [key, value] of Object.entries(s.properties || {})) {
    const child = value as RJSFSchema
    ui[key] = uiSchemaFor(child)
    if (child.type === 'boolean') ui[key]['ui:widget'] = 'select'
    if (child.type === 'string' && isSecretField(key)) ui[key]['ui:widget'] = 'password'
    if (child.type === 'string' && /certificate|ca$|cert$|openvpn-config/.test(key))
      ui[key]['ui:widget'] = 'textarea'
  }
  if (s.items && !Array.isArray(s.items)) ui.items = uiSchemaFor(s.items as RJSFSchema)
  return ui
}
export const isSecretField = (key: string) =>
  /password|secret|token|uuid|private.key|public.key|short.id|authorization|^headers?$|^auth(?:$|[-_])|^psk$|^pre.?shared.key$/i.test(
    key,
  )

export function schemaProblems(input: RJSFSchema, value: unknown): string[] {
  const key = JSON.stringify(input)
  if (!validators.has(key)) validators.set(key, ajv.compile({ ...input, definitions }))
  const check = validators.get(key)!
  if (check(value)) return []
  // AJV messages contain paths and constraints, never include supplied credential values.
  return [
    ...new Set(
      (check.errors || []).map((e) =>
        e.keyword === 'required'
          ? `${e.instancePath || '/'} 缺少 ${e.params.missingProperty}`
          : `${e.instancePath || '/'} ${e.message}`,
      ),
    ),
  ]
}

export function sectionSchema(section: string): RJSFSchema {
  return (definitions[section] as RJSFSchema) || { type: 'object' }
}

export function sectionItemSchema(section: string, type?: string): RJSFSchema {
  const outer = sectionSchema(section)
  const item = (outer.items || outer.additionalProperties || {}) as RJSFSchema
  return (item.anyOf as RJSFSchema[] | undefined)?.find((s) => variantType(s) === type) || item
}
