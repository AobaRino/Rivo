import * as monaco from 'monaco-editor'
import { configureMonacoYaml } from 'monaco-yaml'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker'
import YamlWorker from './yaml.worker?worker'
import { editorSchemas } from './yamlSchema'
import { getSchemaSnapshot, subscribeSchema } from './schemaStore'

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

monaco.editor.defineTheme('mihomo-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '8593A1' },
    { token: 'type', foreground: '456D97' },
    { token: 'string', foreground: '438B71' },
    { token: 'number', foreground: 'AD7440' },
    { token: 'keyword', foreground: '9273B2' },
  ],
  colors: {
    'editor.background': '#fbfcfd',
    'editor.foreground': '#33445a',
    'editorLineNumber.foreground': '#a7b1bd',
    'editorLineNumber.activeForeground': '#438b71',
    'editor.lineHighlightBackground': '#eff4f3',
    'editor.selectionBackground': '#cde9df',
    'editorCursor.foreground': '#16856c',
    'editorSuggestWidget.background': '#ffffff',
    'editorSuggestWidget.border': '#dce4e9',
    'editorHoverWidget.background': '#ffffff',
    'editorHoverWidget.border': '#dce4e9',
  },
})

if (import.meta.hot)
  import.meta.hot.dispose(() => {
    unsubscribe()
    language.dispose()
  })
export { monaco }
