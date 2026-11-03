import { useEffect, useRef, useState } from 'react'
import { Rss } from 'lucide-react'
import type { Config, Group } from '../lib/document'
import { inspectOrder, orderProblem, readOrder } from '../lib/groupOrder'
import { useGroupMembers } from '../lib/useGroupMembers'
import { GroupOrderRecords } from './GroupOrderRecords'

export function GroupMembers({
  config,
  group,
  applied,
  appliedRevision,
  managed,
  disabled,
  onChange,
}: {
  config: Config
  group: Group
  applied: Config
  appliedRevision?: string
  managed: boolean
  disabled: boolean
  onChange: (group: Group) => void
}) {
  const [cleaning, setCleaning] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const blocked = useRef(disabled)
  blocked.current = disabled
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const { available, preview, confirmed, complete, cleanup } = useGroupMembers(
    config,
    group,
    applied,
    appliedRevision,
    managed,
  )
  const order = readOrder(group)
  const members = preview.data?.members || []
  const records = inspectOrder(order?.names || [], available.sources, members, confirmed)
  const issue = orderProblem(group)
  return (
    <>
      <div className="group-members">
        {members.map((member, i) => (
          <div key={`${member.source}:${member.name}`}>
            <span className="member-dot" />
            <span>{member.name}</span>
            <small>顺序 {i + 1}</small>
          </div>
        ))}
        {(group.use || []).map((name) => (
          <div key={`provider:${name}`}>
            <Rss size={14} />
            <span>{name}</span>
            <small>{order ? '新节点追加到末尾' : '订阅'}</small>
          </div>
        ))}
      </div>
      {preview.isPending && <p className="group-order-note">正在读取成员…</p>}
      {(preview.isError || !available.complete) && (
        <p className="group-order-note">节点列表尚未完整确认，已有排序记录会保留。</p>
      )}
      {order && (
        <GroupOrderRecords
          records={records}
          disabled={disabled || !complete || !!issue}
          cleaning={cleaning}
          onClean={() => {
            setCleaning(true)
            setError('')
            void cleanup(group)
              .then((next) => {
                if (mounted.current && !blocked.current) onChange(next)
              })
              .catch((e: unknown) => {
                if (mounted.current) setError(e instanceof Error ? e.message : '无法清理排序记录')
              })
              .finally(() => {
                if (mounted.current) setCleaning(false)
              })
          }}
        />
      )}
      {(error || issue) && (
        <p className="group-order-error" role="alert">
          {error || issue}
        </p>
      )}
    </>
  )
}
