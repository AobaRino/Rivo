import { useMemo, useRef, useState } from 'react'
import Form from '@rjsf/core'
import validator from '@rjsf/validator-ajv8'
import {
  ADDITIONAL_PROPERTY_FLAG,
  type ObjectFieldTemplateProps,
  type RJSFSchema,
} from '@rjsf/utils'
import {
  SchemaAddButton,
  SchemaAdditionalField,
  SchemaArrayItem,
  SchemaField,
  SchemaTitle,
} from './SchemaTemplates'
import { displaySchema, isRecord, uiSchemaFor } from '../lib/mihomoSchema'
import { setObjectPath } from '../lib/structuredEdit'
import type { Path } from '../lib/document'
import './schema-fields.css'

type Context = { set: (path: Path, value: unknown) => void }
const emptyValue = (s: RJSFSchema): unknown =>
  s.anyOf || s.oneOf
    ? emptyValue((s.anyOf || s.oneOf)![0] as RJSFSchema)
    : s.type === 'object'
      ? {}
      : s.type === 'array'
        ? []
        : s.type === 'boolean'
          ? false
          : s.type === 'integer' || s.type === 'number'
            ? undefined
            : ''

function OptionsObject({
  properties,
  schema,
  formData,
  fieldPathId,
  registry,
  onAddProperty,
  title,
}: ObjectFieldTemplateProps<unknown, RJSFSchema, Context>) {
  const [search, setSearch] = useState('')
  const [opened, setOpened] = useState<string[]>([])
  const data = isRecord(formData) ? formData : {}
  const visible = properties.filter(
    (p) =>
      !p.hidden &&
      (Object.hasOwn(data, p.name) || schema.required?.includes(p.name) || opened.includes(p.name)),
  )
  const available = properties.filter(
    (p) =>
      !p.hidden &&
      !visible.includes(p) &&
      `${p.name} ${(schema.properties?.[p.name] as RJSFSchema)?.title || ''}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  )
  const set = registry.formContext.set
  return (
    <div className="schema-object">
      {!!fieldPathId.path.length && (
        <div className="schema-object-title">{title || fieldPathId.path.at(-1)}</div>
      )}
      {visible.map((p) => (
        <div className="schema-property" key={p.name}>
          {p.content}
          {!schema.required?.includes(p.name) &&
            !Object.hasOwn(Object(schema.properties?.[p.name]), ADDITIONAL_PROPERTY_FLAG) && (
              <button
                type="button"
                className="schema-unset"
                aria-label={`移除 ${[...fieldPathId.path, p.name].join('.')}`}
                onClick={() => {
                  setOpened((items) => items.filter((k) => k !== p.name))
                  set([...fieldPathId.path, p.name], undefined)
                }}
              >
                移除字段
              </button>
            )}
        </div>
      ))}
      {properties.some((p) => !p.hidden && !visible.includes(p)) && (
        <div className="schema-add">
          <input
            type="search"
            aria-label={`搜索字段 ${fieldPathId.path.join('.') || '根'}`}
            placeholder="搜索字段名称或中文说明"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            aria-label={`添加字段 ${fieldPathId.path.join('.') || '根'}`}
            value=""
            onChange={(e) => {
              const key = e.target.value
              if (!key) return
              setOpened((items) => [...items, key])
              const value = emptyValue(schema.properties![key] as RJSFSchema)
              if (value !== undefined) set([...fieldPathId.path, key], value)
              setSearch('')
            }}
          >
            <option value="">添加可选字段（{available.length}）</option>
            {available.map((p) => (
              <option key={p.name} value={p.name}>
                {(schema.properties![p.name] as RJSFSchema).title || p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {schema.additionalProperties && (
        <button type="button" className="button small" onClick={onAddProperty}>
          添加键值
        </button>
      )}
    </div>
  )
}

export function SchemaFields({
  schema,
  value,
  onChange,
  hideType = false,
}: {
  schema: RJSFSchema
  value: Record<string, unknown>
  onChange: (value: Record<string, unknown>) => void
  hideType?: boolean
}) {
  // RJSF memoizes templates and treats functions as equal. Read current values through
  // refs so optional-field controls cannot restore an earlier version of the object.
  const valueRef = useRef(value),
    changeRef = useRef(onChange)
  valueRef.current = value
  changeRef.current = onChange
  const display = useMemo(() => displaySchema(schema, value), [schema, value])
  const ui = useMemo(() => {
    const result = uiSchemaFor(display)
    result['ui:order'] = ['name', 'type', 'server', 'port']
      .filter((k) => Object.hasOwn(display.properties || {}, k))
      .concat('*')
    if (hideType) result.type = { 'ui:widget': 'hidden' }
    return result
  }, [display, hideType])
  return (
    <div className="schema-fields">
      <Form
        schema={display}
        formData={value}
        validator={validator}
        uiSchema={ui}
        tagName="div"
        noValidate
        noHtml5Validate
        omitExtraData={false}
        liveOmit={false}
        showErrorList={false}
        experimental_defaultFormStateBehavior={{
          emptyObjectFields: 'skipDefaults',
          arrayMinItems: { populate: 'never' },
          allOf: 'skipDefaults',
          constAsDefaults: 'never',
          requiredBooleanDefault: 'skip',
        }}
        templates={{
          ObjectFieldTemplate: OptionsObject,
          FieldTemplate: SchemaField,
          TitleFieldTemplate: SchemaTitle,
          ArrayFieldItemTemplate: SchemaArrayItem,
          WrapIfAdditionalTemplate: SchemaAdditionalField,
          ButtonTemplates: { AddButton: SchemaAddButton },
        }}
        formContext={{
          set: (path: Path, replacement: unknown) =>
            changeRef.current(
              setObjectPath(valueRef.current, path, replacement) as Record<string, unknown>,
            ),
        }}
        onChange={(event) => changeRef.current(JSON.parse(JSON.stringify(event.formData)))}
      >
        <span />
      </Form>
    </div>
  )
}
