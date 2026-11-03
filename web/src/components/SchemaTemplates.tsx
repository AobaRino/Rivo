import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from 'lucide-react'
import { IconButton } from './WorkspacePrimitives'
import {
  ADDITIONAL_PROPERTY_FLAG,
  getTemplate,
  getUiOptions,
  type ArrayFieldItemTemplateProps,
  type FieldTemplateProps,
  type IconButtonProps,
  type TitleFieldProps,
  type WrapIfAdditionalTemplateProps,
} from '@rjsf/utils'

const itemLabel = (path: (string | number)[]) =>
  `${path.slice(0, -1).join('.')} 第 ${Number(path.at(-1)) + 1} 项`

export function SchemaField(props: FieldTemplateProps) {
  const {
    id,
    label,
    children,
    errors,
    help,
    description,
    hidden,
    required,
    displayLabel,
    fieldPathId,
    registry,
    uiSchema,
  } = props
  const options = getUiOptions(uiSchema)
  const Wrapper = getTemplate('WrapIfAdditionalTemplate', registry, options)
  if (hidden) return <div hidden>{children}</div>
  const arrayItem = typeof fieldPathId.path.at(-1) === 'number'
  return (
    <Wrapper {...props}>
      {displayLabel &&
        !props.schema.anyOf &&
        !props.schema.oneOf &&
        options.widget !== 'checkbox' && (
          <label htmlFor={id} className={arrayItem ? 'sr-only' : 'control-label'}>
            {arrayItem ? itemLabel(fieldPathId.path) : label}
            {required && <span className="schema-required">必填</span>}
          </label>
        )}
      {displayLabel && !arrayItem && description}
      {children}
      {displayLabel && arrayItem && description}
      {errors}
      {help}
    </Wrapper>
  )
}

export function SchemaTitle({ id, title, required, optionalDataControl }: TitleFieldProps) {
  return (
    <legend id={id}>
      {title}
      {required && <span className="schema-required">必填</span>}
      {optionalDataControl}
    </legend>
  )
}

export function SchemaArrayItem({
  children,
  buttonsProps: b,
  hasToolbar,
  index,
  schema,
}: ArrayFieldItemTemplateProps) {
  const complex = schema.type === 'object' || schema.type === 'array'
  const name = itemLabel(b.fieldPathId.path)
  const disabled = b.disabled || b.readonly
  return (
    <div className={`schema-array-item${complex ? ' schema-array-item-complex' : ''}`}>
      <span className="schema-item-index" aria-hidden="true">
        {complex ? `第 ${index + 1} 项` : index + 1}
      </span>
      <div className="schema-item-content">{children}</div>
      {hasToolbar && (
        <div className="schema-item-actions" role="group" aria-label={`${name} 操作`}>
          {(b.hasMoveUp || b.hasMoveDown) && (
            <>
              <IconButton
                outlined
                icon={ArrowUp}
                label={`上移 ${name}`}
                title="上移"
                disabled={disabled || !b.hasMoveUp}
                onClick={b.onMoveUpItem}
              />
              <IconButton
                outlined
                icon={ArrowDown}
                label={`下移 ${name}`}
                title="下移"
                disabled={disabled || !b.hasMoveDown}
                onClick={b.onMoveDownItem}
              />
            </>
          )}
          {b.hasCopy && (
            <IconButton
              outlined
              icon={Copy}
              label={`复制 ${name}`}
              title="复制"
              disabled={disabled}
              onClick={b.onCopyItem}
            />
          )}
          {b.hasRemove && (
            <IconButton
              outlined
              danger
              icon={Trash2}
              label={`删除 ${name}`}
              title="删除此项"
              disabled={disabled}
              onClick={b.onRemoveItem}
            />
          )}
        </div>
      )}
    </div>
  )
}

export function SchemaAddButton({ id, disabled, onClick }: IconButtonProps) {
  return (
    <button
      id={id}
      type="button"
      className="button small schema-array-add"
      disabled={disabled}
      onClick={onClick}
    >
      <Plus size={15} />
      添加一项
    </button>
  )
}

export function SchemaAdditionalField(props: WrapIfAdditionalTemplateProps) {
  const {
    id,
    classNames,
    style,
    schema,
    label,
    children,
    disabled,
    readonly,
    onKeyRenameBlur,
    onRemoveProperty,
  } = props
  if (!(ADDITIONAL_PROPERTY_FLAG in schema))
    return (
      <div className={classNames} style={style}>
        {children}
      </div>
    )
  return (
    <div className={`${classNames || ''} schema-dictionary`} style={style}>
      <div className="schema-dictionary-key">
        <label htmlFor={`${id}-key`}>字段名</label>
        <input
          id={`${id}-key`}
          key={label}
          aria-label={`字段名 ${label}`}
          type="text"
          defaultValue={label}
          disabled={disabled}
          readOnly={readonly}
          onBlur={onKeyRenameBlur}
        />
      </div>
      <div className="schema-dictionary-value">{children}</div>
      <button
        type="button"
        className="button small schema-dictionary-remove"
        aria-label={`删除字段 ${label}`}
        disabled={disabled || readonly}
        onClick={onRemoveProperty}
      >
        <Trash2 size={15} />
        删除字段
      </button>
    </div>
  )
}
