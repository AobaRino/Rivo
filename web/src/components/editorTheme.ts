import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import type { Appearance } from '../app/Appearance'

const theme = EditorView.theme({
  '&': {
    fontSize: '12px',
    backgroundColor: 'var(--surface)',
    color: 'var(--text-primary)',
    height: '100%',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: '"Cascadia Code", Consolas, monospace',
    lineHeight: '1.8',
  },
  '.cm-content': { padding: '16px 0', caretColor: 'var(--accent)' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface)',
    color: 'var(--text-muted)',
    border: 'none',
    paddingRight: '8px',
  },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--surface-muted)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'var(--mint)',
  },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '.cm-panels, .cm-tooltip': {
    backgroundColor: 'var(--surface-muted)',
    color: 'var(--text-primary)',
    borderColor: 'var(--border)',
  },
  '&.cm-merge-a .cm-changedLine, .cm-deletedChunk': {
    backgroundColor: 'var(--danger-bg)',
  },
  '&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine': {
    backgroundColor: 'var(--mint)',
  },
  '&.cm-merge-a .cm-changedText, &.cm-merge-b .cm-deletedText, .cm-deletedChunk .cm-deletedText': {
    background:
      'linear-gradient(var(--text-danger), var(--text-danger)) bottom / 100% 2px no-repeat',
  },
  '&.cm-merge-b .cm-changedText': {
    background:
      'linear-gradient(var(--text-success), var(--text-success)) bottom / 100% 2px no-repeat',
  },
  '&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter': {
    backgroundColor: 'var(--text-danger)',
  },
  '&.cm-merge-b .cm-changedLineGutter, .cm-inlineChangedLineGutter': {
    backgroundColor: 'var(--text-success)',
  },
  '.cm-collapsedLines': {
    color: 'var(--text-muted)',
    background: 'var(--surface-muted)',
  },
})

const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.comment, color: 'var(--text-secondary)' },
    { tag: tags.propertyName, color: 'var(--text-info)' },
    { tag: tags.string, color: 'var(--accent)' },
    { tag: tags.number, color: 'var(--text-warning)' },
    { tag: tags.bool, color: 'var(--text-purple)' },
    { tag: tags.meta, color: 'var(--text-secondary)' },
  ]),
)

export const codeMirrorAppearance = (appearance: Appearance) => [
  theme,
  highlight,
  EditorView.darkTheme.of(appearance === 'dark'),
]
