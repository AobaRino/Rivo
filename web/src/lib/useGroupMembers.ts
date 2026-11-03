import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from './api'
import type { Config, Group } from './document'
import { cleanOrder, memberSources, previewInput } from './groupOrder'

export function useGroupMembers(
  config: Config,
  group: Group,
  applied: Config,
  appliedRevision: string | undefined,
  managed: boolean,
) {
  const providers = useQuery({
    queryKey: ['group-provider-members', appliedRevision],
    queryFn: api.providers,
    enabled: managed,
    refetchInterval: 10000,
    retry: false,
  })
  const live =
    !providers.isError && providers.data?.appliedRevision === appliedRevision
      ? providers.data
      : undefined
  const available = useMemo(
    () => memberSources(config, group, live, applied),
    [config, group, live, applied],
  )
  const input = previewInput(group, available.sources)
  const preview = useQuery({
    queryKey: ['group-order-preview', input],
    queryFn: () => api.groupOrderPreview(input),
    retry: false,
  })
  // Keep the last confirmed classification visible during a background refresh,
  // so expanded records are not unmounted. Mutations still wait for fresh data.
  const confirmed = available.complete && preview.isSuccess && (!managed || !providers.isError)
  const complete = confirmed && !preview.isFetching && (!managed || !providers.isFetching)

  // Re-read before an explicit cleanup. A failed refetch may leave cached data
  // in React Query; that cache must never authorize deleting ordering records.
  const readSources = async (candidate: Group) => {
    const fresh = managed ? (await providers.refetch({ throwOnError: true })).data : undefined
    if (managed && fresh?.appliedRevision !== appliedRevision)
      throw new Error('已应用配置已变化，请刷新页面后重试。')
    const result = memberSources(config, candidate, fresh, applied)
    if (!result.complete) throw new Error('节点列表尚未完整确认，排序记录已保留，请稍后重试。')
    return result.sources
  }
  const cleanup = async (candidate: Group) => {
    const sources = await readSources(candidate)
    const next = cleanOrder(candidate, sources, true)
    const [before, after] = await Promise.all([
      api.groupOrderPreview(previewInput(candidate, sources)),
      api.groupOrderPreview(previewInput(next, sources)),
    ])
    if (JSON.stringify(before.members) !== JSON.stringify(after.members))
      throw new Error('清理会改变有效成员顺序，已保留原排序，请检查筛选设置。')
    return next
  }
  return { providers, available, preview, confirmed, complete, readSources, cleanup }
}
