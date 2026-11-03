import type { inspectOrder } from '../lib/groupOrder'
import './ordered-list.css'

export function GroupOrderRecords({
  records,
  onClean,
  disabled,
  cleaning,
}: {
  records: ReturnType<typeof inspectOrder>
  onClean: () => void
  disabled?: boolean
  cleaning?: boolean
}) {
  return (
    <>
      {!!records.stale.length && (
        <details className="group-order-records">
          <summary>已失效的排序记录 · {records.stale.length}</summary>
          <ul>
            {records.stale.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          <p>这些名称已不在当前来源中。清理只修改草稿，保存前可预览或放弃。</p>
          <button
            type="button"
            className="button small"
            disabled={disabled || cleaning}
            onClick={onClean}
          >
            {cleaning ? '正在核对…' : '一键清理失效记录'}
          </button>
        </details>
      )}
      {!!records.hidden.length && (
        <details className="group-order-records">
          <summary>被筛选隐藏的排序记录 · {records.hidden.length}</summary>
          <ul>
            {records.hidden.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          <p>来源中仍有这些节点，保留其顺序，不会清理。</p>
        </details>
      )}
      {!!records.unresolved.length && (
        <details className="group-order-records">
          <summary>待确认的排序记录 · {records.unresolved.length}</summary>
          <ul>
            {records.unresolved.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          <p>节点列表尚未完整确认，暂不判断失效或清理。</p>
        </details>
      )}
    </>
  )
}
