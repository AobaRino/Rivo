import { useEffect, useRef, useState } from 'react'
import { applyMonacoAppearance, monaco, monacoThemeName } from '../lib/yamlLanguage'
import { useSchemaSnapshot } from '../lib/schemaStore'
import { getAppearance, useAppearance } from '../app/Appearance'
import './yaml-editor.css'

// Models only need unique names within this Monaco instance. Router HTTP pages
// are not secure contexts, so crypto.randomUUID() is unavailable there.
let modelSequence = 0

export default function YamlEditor({
  value,
  onChange,
  height = '560px',
  ariaLabel = 'YAML 源码编辑器',
  schemaContext = 'config',
}: {
  value: string
  onChange?: (text: string) => void
  height?: string
  ariaLabel?: string
  schemaContext?: 'config' | 'proxy'
}) {
  const appearance = useAppearance()
  const schema = useSchemaSnapshot()
  const container = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const listener = useRef(onChange)
  const currentValue = useRef(value)
  listener.current = onChange
  currentValue.current = value
  const external = useRef(false)
  const [markers, setMarkers] = useState<monaco.editor.IMarker[]>([])
  const [showProblems, setShowProblems] = useState(false)

  useEffect(() => {
    applyMonacoAppearance(appearance)
  }, [appearance])

  useEffect(() => {
    if (!container.current) return
    const uri = monaco.Uri.parse(`inmemory://mihomo/${schemaContext}-${++modelSequence}.yaml`)
    const model = monaco.editor.createModel(currentValue.current, 'yaml', uri)
    model.updateOptions({ tabSize: 2, insertSpaces: true })
    const editor = monaco.editor.create(container.current, {
      model,
      theme: monacoThemeName(getAppearance()),
      ariaLabel,
      // Use the established textarea input path across embedded browsers and IMEs.
      editContext: false,
      automaticLayout: true,
      fontFamily: '"Cascadia Code", Consolas, monospace',
      fontSize: 13,
      lineHeight: 23,
      padding: { top: 12, bottom: 12 },
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      stickyScroll: { enabled: false },
      folding: true,
      glyphMargin: false,
      lineNumbersMinChars: 3,
      renderValidationDecorations: 'on',
      quickSuggestions: { other: true, comments: false, strings: true },
      suggest: { showWords: false, showClasses: false, preview: false },
      wordBasedSuggestions: 'off',
      acceptSuggestionOnEnter: 'smart',
      tabCompletion: 'off',
      formatOnPaste: false,
      formatOnType: false,
      fixedOverflowWidgets: true,
      unicodeHighlight: { nonBasicASCII: false, ambiguousCharacters: false },
    })
    editorRef.current = editor
    const change = model.onDidChangeContent(() => {
      if (!external.current) listener.current?.(model.getValue())
    })
    const diagnostics = monaco.editor.onDidChangeMarkers((resources) => {
      if (!resources.some((resource) => resource.toString() === uri.toString())) return
      setMarkers(
        monaco.editor
          .getModelMarkers({ resource: uri })
          .sort((a, b) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn),
      )
    })
    setMarkers([])
    return () => {
      diagnostics.dispose()
      change.dispose()
      editor.dispose()
      model.dispose()
      editorRef.current = null
    }
  }, [schemaContext, ariaLabel])

  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || model.getValue() === value) return
    const old = model.getValue()
    let start = 0
    let oldEnd = old.length
    let newEnd = value.length
    while (start < oldEnd && start < newEnd && old[start] === value[start]) start++
    while (oldEnd > start && newEnd > start && old[oldEnd - 1] === value[newEnd - 1]) {
      oldEnd--
      newEnd--
    }
    const from = model.getPositionAt(start)
    const to = model.getPositionAt(oldEnd)
    external.current = true
    try {
      editor.pushUndoStop()
      editor.executeEdits('external-yaml', [
        {
          range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column),
          text: value.slice(start, newEnd),
        },
      ])
      editor.pushUndoStop()
    } finally {
      external.current = false
    }
  }, [value])

  function action(id: string) {
    const editor = editorRef.current
    editor?.focus()
    void editor?.getAction(id)?.run()
  }

  function reveal(marker: monaco.editor.IMarker) {
    const editor = editorRef.current
    editor?.setSelection(marker)
    editor?.revealLineInCenterIfOutsideViewport(marker.startLineNumber)
    editor?.focus()
  }

  return (
    <div className="editor yaml-editor" style={{ height }}>
      <div className="yaml-editor-tools">
        <span>智能提示</span>
        <button
          type="button"
          onClick={() => action('editor.action.triggerSuggest')}
          title="Ctrl+Space"
        >
          字段 / 备选值
        </button>
        <button
          type="button"
          onClick={() => action('editor.action.showHover')}
          title="显示光标所在字段的说明"
        >
          字段说明
        </button>
        <span
          className="yaml-editor-version"
          title={
            schema.warning ||
            (schema.coreVersion ? `对应内核 ${schema.coreVersion}` : '内置提示规则')
          }
        >
          Schema {schema.version}
          {schema.warning ? ' · 版本提示' : ''}
        </span>
      </div>
      <div className="yaml-editor-surface" ref={container} />
      {schema.warning && (
        <div className="yaml-schema-warning" role="status">
          {schema.warning}
        </div>
      )}
      <div className="yaml-editor-diagnostics">
        <button
          type="button"
          className={markers.length ? 'has-problems' : ''}
          aria-expanded={showProblems}
          onClick={() => setShowProblems((previous) => !previous)}
        >
          {markers.length ? `${markers.length} 个问题` : '问题列表'}
          {showProblems ? ' ▴' : ' ▾'}
        </button>
        <span>语法与字段检查 · F8 定位问题</span>
      </div>
      {showProblems && (
        <div className="yaml-editor-problems" aria-label="YAML 问题列表">
          {markers.length === 0 && <p>暂无诊断信息。此处不执行内核校验。</p>}
          {markers.map((marker, index) => (
            <button
              type="button"
              key={`${marker.startLineNumber}:${marker.startColumn}:${index}`}
              onClick={() => reveal(marker)}
            >
              <span
                className={marker.severity === monaco.MarkerSeverity.Error ? 'error' : 'warning'}
              >
                {marker.severity === monaco.MarkerSeverity.Error ? '错误' : '提示'}
              </span>
              <span>
                第 {marker.startLineNumber} 行，第 {marker.startColumn} 列
              </span>
              <span>{marker.message}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
