import { useEffect, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { yaml } from '@codemirror/lang-yaml'
import { MergeView } from '@codemirror/merge'
import { getAppearance, useAppearance } from '../app/Appearance'
import { codeMirrorAppearance } from './editorTheme'

export default function DiffEditor({ before, after }: { before: string; after: string }) {
  const appearance = useAppearance()
  const themeCompartment = useRef(new Compartment())
  const ref = useRef<HTMLDivElement>(null)
  const merge = useRef<MergeView | null>(null)
  useEffect(() => {
    if (!ref.current) return
    const view = new MergeView({
      parent: ref.current,
      a: {
        doc: before,
        extensions: [
          basicSetup,
          yaml(),
          themeCompartment.current.of(codeMirrorAppearance(getAppearance())),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      },
      b: {
        doc: after,
        extensions: [
          basicSetup,
          yaml(),
          themeCompartment.current.of(codeMirrorAppearance(getAppearance())),
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
        ],
      },
      collapseUnchanged: { margin: 3, minSize: 5 },
      highlightChanges: true,
      gutter: true,
    })
    merge.current = view
    return () => {
      view.destroy()
      merge.current = null
    }
  }, [before, after])
  useEffect(() => {
    const effects = themeCompartment.current.reconfigure(codeMirrorAppearance(appearance))
    merge.current?.a.dispatch({ effects })
    merge.current?.b.dispatch({ effects })
  }, [appearance])
  return <div className="diff-editor" ref={ref} />
}
