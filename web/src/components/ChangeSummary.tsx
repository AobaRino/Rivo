import { useMemo } from 'react'
import { summarizeBlocks } from '../lib/blockChanges'

export function ChangeSummary({ before, after }: { before: string; after: string }) {
  const summary = useMemo(() => summarizeBlocks(before, after), [before, after])
  return (
    <section className="change-summary" aria-label="中文变更摘要">
      <h3>变更摘要</h3>
      {summary.note && <p className="change-summary-note">{summary.note}</p>}
      <ul className="block-changes">
        {summary.changes.map((change) => (
          <li key={change.key}>
            <span>{change.title}</span>
            <span className="line-count">
              <ins>+{change.added}</ins>
              <del>−{change.removed}</del> 行
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
