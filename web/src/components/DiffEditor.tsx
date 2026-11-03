import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { yaml } from '@codemirror/lang-yaml'
import { MergeView } from '@codemirror/merge'
import { highlight, theme } from './Editor'

export default function DiffEditor({ before, after }: { before: string; after: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const view = new MergeView({
      parent: ref.current,
      a: {
        doc: before,
        extensions: [
          basicSetup,
          yaml(),
          theme,
          highlight,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      },
      b: {
        doc: after,
        extensions: [
          basicSetup,
          yaml(),
          theme,
          highlight,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      },
      collapseUnchanged: { margin: 3, minSize: 5 },
      highlightChanges: true,
      gutter: true,
    })
    return () => view.destroy()
  }, [before, after])
  return <div className="diff-editor" ref={ref} />
}
