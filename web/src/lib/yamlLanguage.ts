import * as monaco from 'monaco-editor'
import { configureMonacoYaml } from 'monaco-yaml'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker'
import YamlWorker from './yaml.worker?worker'
import { editorSchemas } from './yamlSchema'
import { getSchemaSnapshot, subscribeSchema } from './schemaStore'
import type { Appearance } from '../app/Appearance'

globalThis.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    return label === 'yaml' ? new YamlWorker() : new EditorWorker()
  },
}

// One service shared by all editors; schema matching isolates each model.
const language = configureMonacoYaml(monaco, {
  completion: true,
  hover: true,
  hoverSchemaSource: false,
  validate: true,
  yamlVersion: '1.2',
  enableSchemaRequest: false,
  disableDefaultProperties: true,
  disableAdditionalProperties: false,
  format: { enable: false },
  schemas: editorSchemas(getSchemaSnapshot()),
})
let activeSchema = getSchemaSnapshot().schema
const unsubscribe = subscribeSchema(() => {
  const snapshot = getSchemaSnapshot()
  if (snapshot.schema === activeSchema) return
  activeSchema = snapshot.schema
  void language.update({ schemas: editorSchemas(snapshot) })
})

export const monacoThemeName = (appearance: Appearance) => `rivo-${appearance}`

export function applyMonacoAppearance(appearance: Appearance) {
  // Monaco expects resolved colors, so share the app tokens without copying its palette.
  const style = getComputedStyle(document.documentElement)
  const color = (token: string) => style.getPropertyValue(token).trim()
  const foreground = (token: string) => color(token).replace(/^#/, '')
  const name = monacoThemeName(appearance)
  monaco.editor.defineTheme(name, {
    base: appearance === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: foreground('--text-muted') },
      { token: 'type', foreground: foreground('--text-info') },
      { token: 'string', foreground: foreground('--accent') },
      { token: 'number', foreground: foreground('--text-warning') },
      { token: 'keyword', foreground: foreground('--text-purple') },
    ],
    colors: {
      'editor.background': color('--surface'),
      'editor.foreground': color('--text-primary'),
      'editorLineNumber.foreground': color('--text-muted'),
      'editorLineNumber.activeForeground': color('--accent'),
      'editor.lineHighlightBackground': color('--surface-muted'),
      'editor.selectionBackground': color('--mint'),
      'editor.inactiveSelectionBackground': color('--mint'),
      'editorCursor.foreground': color('--accent'),
      'editorGutter.background': color('--surface'),
      'editorSuggestWidget.background': color('--surface'),
      'editorSuggestWidget.foreground': color('--text-primary'),
      'editorSuggestWidget.border': color('--border'),
      'editorSuggestWidget.selectedBackground': color('--mint'),
      'editorSuggestWidget.highlightForeground': color('--accent'),
      'editorHoverWidget.background': color('--surface'),
      'editorHoverWidget.foreground': color('--text-primary'),
      'editorHoverWidget.border': color('--border'),
      'editorWidget.background': color('--surface'),
      'editorWidget.border': color('--border'),
      'input.background': color('--surface-muted'),
      'input.foreground': color('--text-primary'),
      'input.border': color('--border'),
      focusBorder: color('--accent'),
      'editorError.foreground': color('--text-danger'),
      'editorWarning.foreground': color('--text-warning'),
    },
  })
  monaco.editor.setTheme(name)
}

if (import.meta.hot)
  import.meta.hot.dispose(() => {
    unsubscribe()
    language.dispose()
  })
export { monaco }
