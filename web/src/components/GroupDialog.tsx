import { useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Modal } from './Modal'
import { Field, Badge } from './WorkspacePrimitives'
import { OrderedList } from './OrderedList'
import { GroupOrderRecords } from './GroupOrderRecords'
import { api } from '../lib/api'
import { useGroupMembers } from '../lib/useGroupMembers'
import type { Config, Group } from '../lib/document'
import {
  cleanOrderNames,
  inspectOrder,
  moveActiveOrder,
  moveEntry,
  orderProblem,
  previewInput,
  readOrder,
  sourceGroup,
  withOrder,
} from '../lib/groupOrder'

export function GroupDialog({
  value,
  existing,
  config,
  applied,
  appliedRevision,
  managed,
  selection,
  onClose,
  onSave,
}: {
  value: Group
  existing: boolean
  config: Config
  applied: Config
  appliedRevision?: string
  managed: boolean
  selection?: string
  onClose: () => void
  onSave: (group: Group) => void
}) {
  const [group, setGroup] = useState(() => sourceGroup(value))
  const [custom, setCustom] = useState(!!readOrder(value))
  const [order, setOrder] = useState(readOrder(value)?.names || [])
  const [orderMoved, setOrderMoved] = useState(false)
  const [cleanedNames, setCleanedNames] = useState<string[]>([])
  const [cleaning, setCleaning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const closed = useRef(false)
  useEffect(() => {
    closed.current = false
    return () => {
      closed.current = true
    }
  }, [])
  const close = () => {
    closed.current = true
    onClose()
  }
  const issue = orderProblem(value)
  const { providers, available, preview, confirmed, complete, readSources, cleanup } =
    useGroupMembers(config, group, applied, appliedRevision, managed)
  const members = preview.data?.members || []
  const records = inspectOrder(order, available.sources, members, confirmed)
  const working = saving || cleaning
  const orderedGroup = () => {
    const next = withOrder(group, order)
    // Only an explicit reorder may change manual member order. Cleaning stale
    // metadata must not normalize a user's separately edited proxies list.
    if (!orderMoved && group.proxies) next.proxies = group.proxies
    return next
  }
  const clean = async () => {
    setError('')
    setCleaning(true)
    try {
      const next = await cleanup(orderedGroup())
      if (closed.current) return
      const names = readOrder(next)!.names
      const removed = order.filter((name) => !names.includes(name))
      setCleanedNames((previous) => [...new Set([...previous, ...removed])])
      setOrder(names)
    } catch (e) {
      if (!closed.current) setError(e instanceof Error ? e.message : '无法清理排序记录')
    } finally {
      if (!closed.current) setCleaning(false)
    }
  }
  const names = [
    ...new Set([
      'DIRECT',
      'REJECT',
      ...(group.proxies || []),
      ...(config.proxies || []).map((n) => n.name),
      ...(config['proxy-groups'] || []).filter((g) => g.name !== value.name).map((g) => g.name),
    ]),
  ]
  const providerNames = Object.keys(config['proxy-providers'] || {})
  const automatic = !!(
    group['include-all'] ||
    group['include-all-proxies'] ||
    group['include-all-providers']
  )
  const failure = error || issue || (preview.error instanceof Error ? preview.error.message : '')
  const toggle = (field: 'proxies' | 'use', name: string, selected: boolean) => {
    setError('')
    setGroup((g) => ({
      ...g,
      [field]: selected ? [...(g[field] || []), name] : (g[field] || []).filter((n) => n !== name),
    }))
  }
  const setMode = (next: boolean) => {
    setError('')
    if (next && !order.length) setOrder(members.map((n) => n.name))
    setCustom(next)
  }
  return (
    <Modal title={existing ? '编辑代理组' : '添加代理组'} onClose={close} size="medium">
      <form
        onSubmit={async (event) => {
          event.preventDefault()
          if (working) return
          setError('')
          setSaving(true)
          try {
            const next = custom ? orderedGroup() : group
            const sources = cleanedNames.length ? await readSources(next) : available.sources
            if (cleanedNames.length && cleanOrderNames(cleanedNames, sources, true).length)
              throw new Error('已清理的名称重新出现在来源中，请取消并重新打开后核对排序。')
            const checked = await api.groupOrderPreview(previewInput(next, sources))
            const expected = (custom ? records.active : members).map((n) => n.name)
            if (JSON.stringify(checked.members.map((n) => n.name)) !== JSON.stringify(expected))
              throw new Error('此配置的自动包含或筛选设置无法产生当前顺序，请改用显式成员后重试。')
            if (!closed.current) onSave(next)
          } catch (e) {
            setError(e instanceof Error ? e.message : '无法更新草稿')
          } finally {
            setSaving(false)
          }
        }}
      >
        <div className="modal-form">
          <div className="field-grid">
            <Field label="代理组名称">
              <input
                aria-label="代理组名称"
                required
                disabled={working}
                value={group.name}
                onChange={(e) => setGroup((g) => ({ ...g, name: e.target.value }))}
              />
            </Field>
            <Field label="策略类型">
              <select
                aria-label="策略类型"
                value={group.type}
                disabled={existing || working}
                onChange={(e) =>
                  setGroup((g) => ({
                    ...g,
                    type: e.target.value,
                    ...(['url-test', 'fallback', 'load-balance'].includes(e.target.value)
                      ? { url: 'https://www.gstatic.com/generate_204', interval: 300 }
                      : {}),
                  }))
                }
              >
                <option value="select">select · 手动选择</option>
                <option value="url-test">url-test · 自动测试</option>
                <option value="fallback">fallback · 故障转移</option>
                <option value="load-balance">load-balance · 负载均衡</option>
                {!['select', 'url-test', 'fallback', 'load-balance'].includes(group.type) && (
                  <option value={group.type}>{group.type}</option>
                )}
              </select>
            </Field>
          </div>
          <Field
            label="手动成员"
            hint="自建节点、代理组和内置出口。订阅中的节点在下方混排，不会复制为自建节点。"
          >
            <div className="checkbox-list">
              {names.map((name) => (
                <label key={name}>
                  <input
                    type="checkbox"
                    disabled={working}
                    checked={group.proxies?.includes(name) || false}
                    onChange={(e) => toggle('proxies', name, e.target.checked)}
                  />
                  {name}
                </label>
              ))}
            </div>
          </Field>
          <Field label="订阅来源">
            <div className="checkbox-list">
              {providerNames.length ? (
                providerNames.map((name) => (
                  <label key={name}>
                    <input
                      type="checkbox"
                      aria-label={`使用订阅 ${name}`}
                      checked={group.use?.includes(name) || false}
                      disabled={
                        working || !!(group['include-all'] || group['include-all-providers'])
                      }
                      onChange={(e) => toggle('use', name, e.target.checked)}
                    />
                    {name}
                  </label>
                ))
              ) : (
                <small>暂无订阅，请先在节点管理中添加。</small>
              )}
            </div>
          </Field>
          <section className="group-order-section" aria-label="成员排序">
            <div className="group-order-heading">
              <h3>成员排序</h3>
              {selection && <Badge tone="gray">当前选择：{selection}</Badge>}
            </div>
            <div className="segmented" role="group" aria-label="排序方式">
              <button
                type="button"
                aria-pressed={!custom}
                disabled={working}
                onClick={() => setMode(false)}
              >
                跟随来源
              </button>
              <button
                type="button"
                aria-pressed={custom}
                disabled={
                  working ||
                  !!issue ||
                  preview.isPending ||
                  !!preview.error ||
                  !!available.duplicates.length
                }
                onClick={() => setMode(true)}
              >
                自定义混排
              </button>
            </div>
            <p className="group-order-note">
              {custom
                ? '拖动或用箭头调整有效节点顺序。新节点放在末尾；失效和暂未确认的排序记录单独保留，可核对后清理。'
                : '手动成员在前，订阅在后。订阅内部跟随来源；切换为自定义混排可将订阅节点放到自建节点前面。'}
            </p>
            {group.type === 'fallback' && (
              <p className="group-order-warning">
                故障转移按成员顺序选择可用节点，调整顺序会改变优先级。
              </p>
            )}
            {group.type === 'relay' && (
              <p className="group-order-warning">
                链式代理的顺序决定连接路径，调整顺序会改变代理链。
              </p>
            )}
            {automatic && (
              <p className="group-order-note">
                已启用 include-all 自动包含。预览按内核规则计算，自动包含的来源顺序由内核决定。
              </p>
            )}
            {!!config.profile &&
              (config.profile as Record<string, unknown>)['store-selected'] === false && (
                <p className="group-order-warning">
                  当前 profile.store-selected 为
                  false；重新应用配置或重启后，内核不会持久保留手动选择。排序操作本身不会切换节点。
                </p>
              )}
            {managed && (
              <button
                type="button"
                className="text-button"
                disabled={working || providers.isFetching}
                onClick={() => void providers.refetch()}
              >
                <RefreshCw size={14} />
                重新读取已加载节点
              </button>
            )}
            {available.notices.map((n) => (
              <p className="group-order-note" key={n}>
                {n}
              </p>
            ))}
            {providers.error && (
              <p className="group-order-warning">
                无法读取内核订阅列表，当前仅预览草稿中的节点与保留的排序。
              </p>
            )}
            {!!available.duplicates.length && (
              <p className="group-order-warning">
                发现同名成员：{available.duplicates.join('、')}。请先使节点名称唯一，再设置混排。
              </p>
            )}
            {preview.isPending ? (
              <p className="group-order-note">正在读取成员…</p>
            ) : custom ? (
              <div className="group-order-members">
                <OrderedList
                  items={records.active}
                  itemKey={(n) => n.name}
                  label={(n) => n.name}
                  disabled={working || !!issue || !!available.duplicates.length}
                  onMove={(from, to) => {
                    setOrderMoved(true)
                    setOrder(
                      moveActiveOrder(
                        order,
                        records.active.map((n) => n.name),
                        from,
                        to,
                      ),
                    )
                  }}
                  render={(n) => (
                    <div>
                      <strong>{n.name}</strong>
                      <small>
                        {n.source} · {n.type}
                      </small>
                    </div>
                  )}
                />
                {!records.active.length && (
                  <p className="group-order-note">
                    暂无可排序成员。订阅需先由内核加载，本地预览可使用 inline 订阅。
                  </p>
                )}
                <GroupOrderRecords
                  records={records}
                  onClean={() => void clean()}
                  disabled={working || !!issue || !complete}
                  cleaning={cleaning}
                />
                {!!cleanedNames.length && (
                  <p className="group-order-note" role="status">
                    已清理 {cleanedNames.length} 条排序记录。更新草稿后，仍需预览并确认保存。
                  </p>
                )}
              </div>
            ) : (
              <>
                {!!group.proxies?.length && (
                  <Field label="手动成员顺序">
                    <OrderedList
                      items={group.proxies}
                      itemKey={(n) => n}
                      label={(n) => n}
                      render={(n) => n}
                      disabled={working}
                      onMove={(a, b) =>
                        setGroup((g) => ({ ...g, proxies: moveEntry(g.proxies || [], a, b) }))
                      }
                    />
                  </Field>
                )}
                {!!group.use?.length &&
                  !group['include-all'] &&
                  !group['include-all-providers'] && (
                    <Field label="订阅来源顺序">
                      <OrderedList
                        items={group.use}
                        itemKey={(n) => n}
                        label={(n) => n}
                        render={(n) => n}
                        disabled={working}
                        onMove={(a, b) =>
                          setGroup((g) => ({ ...g, use: moveEntry(g.use || [], a, b) }))
                        }
                      />
                    </Field>
                  )}
                <Field label="成员预览">
                  <div className="group-order-preview">
                    {members.map((n, i) => (
                      <span key={`${n.source}-${n.name}-${i}`}>
                        {i + 1}. {n.name}
                      </span>
                    ))}
                  </div>
                </Field>
              </>
            )}
          </section>
          <p className="group-order-note">
            按节点名称保留顺序；订阅改名会视为新节点。只更新草稿，不切换当前节点。保存和应用前仍可查看
            YAML 差异。Zashboard 选择“按配置排序”即可显示相同顺序。
          </p>
          {failure && (
            <p className="group-order-error" role="alert">
              {failure}
            </p>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="button" onClick={close}>
            取消
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={
              working ||
              !!issue ||
              preview.isPending ||
              !!preview.error ||
              (custom && !!available.duplicates.length) ||
              (!group.proxies?.length && !group.use?.length && !automatic)
            }
          >
            {saving ? '正在校验…' : '更新草稿'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
