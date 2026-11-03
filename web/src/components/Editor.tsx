import { lazy, Suspense, useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { yaml } from '@codemirror/lang-yaml'
import { indentWithTab } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

const YamlEditor = lazy(() => import('./YamlEditor'))

type EditorProps = {
  value: string
  onChange?: (text: string) => void
  height?: string
  readOnly?: boolean
  ariaLabel?: string
  schemaContext?: 'config' | 'proxy'
}

export const theme = EditorView.theme({
  '&': { fontSize: '12px', backgroundColor: '#fbfcfd', color: '#33445a', height: '100%' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: '"Cascadia Code", Consolas, monospace',
    lineHeight: '1.8',
  },
  '.cm-content': { padding: '16px 0', caretColor: '#16856c' },
  '.cm-gutters': {
    backgroundColor: '#fbfcfd',
    color: '#a7b1bd',
    border: 'none',
    paddingRight: '8px',
  },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#eff4f3' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#cde9df' },
})
export const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.comment, color: '#95a0ad' },
    { tag: tags.propertyName, color: '#456d97' },
    { tag: tags.string, color: '#438b71' },
    { tag: tags.number, color: '#ad7440' },
    { tag: tags.bool, color: '#9273b2' },
    { tag: tags.meta, color: '#8e9ba9' },
  ]),
)
export function Editor(props: EditorProps) {
  if (props.readOnly) return <PreviewEditor {...props} />
  return (
    <Suspense
      fallback={
        <div className="editor" style={{ height: props.height || '560px', padding: 16 }}>
          正在加载 YAML 编辑器…
        </div>
      }
    >
      <YamlEditor {...props} />
    </Suspense>
  )
}

function PreviewEditor({
  value,
  onChange,
  height = '560px',
  readOnly = false,
  ariaLabel,
}: EditorProps) {
  const container = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const listener = useRef(onChange)
  listener.current = onChange
  const external = useRef(false)
  useEffect(() => {
    if (!container.current) return
    const editor = new EditorView({
      parent: container.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          yaml(),
          theme,
          highlight,
          keymap.of([indentWithTab]),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.contentAttributes.of({
            'aria-label': ariaLabel || (readOnly ? 'YAML 配置预览' : 'YAML 源码编辑器'),
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !external.current)
              listener.current?.(update.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = editor
    return () => {
      editor.destroy()
      view.current = null
    }
  }, [readOnly])
  useEffect(() => {
    const v = view.current
    if (!v || v.state.doc.toString() === value) return
    external.current = true
    const old = v.state.doc.toString()
    let start = 0
    while (start < old.length && start < value.length && old[start] === value[start]) start++
    let a = old.length,
      b = value.length
    while (a > start && b > start && old[a - 1] === value[b - 1]) {
      a--
      b--
    }
    v.dispatch({ changes: { from: start, to: a, insert: value.slice(start, b) } })
    external.current = false
  }, [value])
  return <div className="editor" style={{ height }} ref={container} />
}
