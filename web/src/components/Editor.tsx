import { lazy, Suspense, useEffect, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { yaml } from '@codemirror/lang-yaml'
import { indentWithTab } from '@codemirror/commands'
import { getAppearance, useAppearance } from '../app/Appearance'
import { codeMirrorAppearance } from './editorTheme'

const YamlEditor = lazy(() => import('./YamlEditor'))

type EditorProps = {
  value: string
  onChange?: (text: string) => void
  height?: string
  readOnly?: boolean
  ariaLabel?: string
  schemaContext?: 'config' | 'proxy'
}

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
  const appearance = useAppearance()
  const themeCompartment = useRef(new Compartment())
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
          themeCompartment.current.of(codeMirrorAppearance(getAppearance())),
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
    view.current?.dispatch({
      effects: themeCompartment.current.reconfigure(codeMirrorAppearance(appearance)),
    })
  }, [appearance])
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
