import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRuntimeStatus } from './api'
import type { Config } from './document'
import { readOrder, withOrder } from './groupOrder'
import { useGroupMembers } from './useGroupMembers'

const mocks = vi.hoisted(() => ({ query: vi.fn(), preview: vi.fn() }))
vi.mock('@tanstack/react-query', () => ({ useQuery: mocks.query }))
vi.mock('./api', () => ({ api: { providers: vi.fn(), groupOrderPreview: mocks.preview } }))

const config: Config = {
  proxies: [{ name: 'Self', type: 'direct' }],
  'proxy-providers': { sub: { type: 'http', url: 'https://example.com/sub.yaml' } },
}
const group = withOrder(
  { name: 'Default', type: 'select', proxies: ['Self', 'DIRECT'], use: ['sub'] },
  ['Old', 'Sub-A', 'Self', 'DIRECT'],
)
const member = (name: string) => ({
  name,
  type: 'Direct',
  source: name === 'Sub-A' ? 'sub' : '手动成员',
})
const members = ['Sub-A', 'Self', 'DIRECT'].map(member)
const runtime = (names = ['Sub-A']): ProviderRuntimeStatus => ({
  appliedRevision: 'applied-rev',
  providers: [
    {
      name: 'sub',
      type: 'http',
      state: 'loaded',
      nodes: names.length,
      members: names.map((name) => ({ name, type: 'Direct' })),
    },
  ],
})

let providers: {
  data: ProviderRuntimeStatus
  isError: boolean
  isFetching: boolean
  refetch: ReturnType<typeof vi.fn>
}
let preview: {
  data: { members: typeof members }
  isSuccess: boolean
  isFetching: boolean
}

function renderMembers() {
  let result!: ReturnType<typeof useGroupMembers>
  function Probe() {
    result = useGroupMembers(config, group, config, 'applied-rev', true)
    return null
  }
  renderToString(createElement(Probe))
  return result
}

beforeEach(() => {
  vi.resetAllMocks()
  providers = {
    data: runtime(),
    isError: false,
    isFetching: false,
    refetch: vi.fn().mockResolvedValue({ data: runtime() }),
  }
  preview = { data: { members }, isSuccess: true, isFetching: false }
  mocks.query.mockImplementation(({ queryKey }: { queryKey: unknown[] }) =>
    queryKey[0] === 'group-provider-members' ? providers : preview,
  )
  mocks.preview.mockResolvedValue({ members })
})

describe('group member confirmation and cleanup', () => {
  it.each(['providers', 'preview'])(
    'keeps record classification confirmed while %s refreshes, but disables cleanup',
    (query) => {
      if (query === 'providers') providers.isFetching = true
      else preview.isFetching = true
      const result = renderMembers()
      expect(result.confirmed).toBe(true)
      expect(result.complete).toBe(false)
    },
  )

  it('does not treat cached provider data as confirmation after a query error', () => {
    providers.isError = true
    const result = renderMembers()
    expect(providers.data.providers[0].members).toHaveLength(1)
    expect(result.confirmed).toBe(false)
    expect(result.complete).toBe(false)
    expect(result.available.complete).toBe(false)
  })

  it('stops cleanup before preview when the required fresh read fails', async () => {
    providers.refetch.mockRejectedValue(new Error('provider read failed'))
    await expect(renderMembers().cleanup(group)).rejects.toThrow('provider read failed')
    expect(providers.refetch).toHaveBeenCalledWith({ throwOnError: true })
    expect(mocks.preview).not.toHaveBeenCalled()
    expect(readOrder(group)?.names).toContain('Old')
  })

  it('keeps a previously absent name if it returns in the fresh source', async () => {
    providers.refetch.mockResolvedValue({ data: runtime(['Sub-A', 'Old']) })
    mocks.preview.mockResolvedValue({ members: [member('Old'), ...members] })
    const next = await renderMembers().cleanup(group)
    expect(next).toBe(group)
    expect(readOrder(next)?.names).toEqual(['Old', 'Sub-A', 'Self', 'DIRECT'])
    expect(providers.data.providers[0].members?.map((n) => n.name)).toEqual(['Sub-A'])
  })

  it('rejects a cleanup that changes the effective member order', async () => {
    mocks.preview
      .mockResolvedValueOnce({ members })
      .mockResolvedValueOnce({ members: [members[1], members[0], members[2]] })
    await expect(renderMembers().cleanup(group)).rejects.toThrow('清理会改变有效成员顺序')
    expect(mocks.preview).toHaveBeenCalledTimes(2)
    expect(readOrder(group)?.names).toEqual(['Old', 'Sub-A', 'Self', 'DIRECT'])
  })
})
