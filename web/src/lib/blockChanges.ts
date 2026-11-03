import { diff } from '@codemirror/merge'
import { isMap, isScalar, parseDocument } from 'yaml'

export type BlockChange = { key: string; title: string; added: number; removed: number }
const titles: Record<string, string> = {
  proxies: '节点',
  'proxy-providers': '订阅',
  'proxy-groups': '代理组',
  rules: '分流规则',
  'rule-providers': '规则集',
  'sub-rules': '子规则',
  dns: 'DNS',
  tun: 'TUN',
  sniffer: '流量嗅探',
  hosts: 'Hosts',
  profile: '配置持久化',
  listeners: '监听器',
  tunnels: '隧道',
  'tuic-server': 'TUIC 服务',
  ntp: 'NTP',
  experimental: '实验设置',
  general: '通用设置',
  geo: 'GEO 资源',
  comments: '注释与格式',
}
function blocks(text: string): Map<string, string[]> {
  const normalized = text.replace(/\r\n/g, '\n')
  const doc = parseDocument(normalized, { uniqueKeys: true })
  if (doc.errors.length || !isMap(doc.contents) || doc.contents.flow) throw new Error('YAML')
  const pairs = doc.contents.items
  const result = new Map<string, string[]>()
  const append = (key: string, content: string) => {
    if (content.endsWith('\n')) content = content.slice(0, -1)
    if (content) result.set(key, [...(result.get(key) || []), ...content.split('\n')])
  }
  const starts = pairs.map((p) => {
    if (!isScalar(p.key) || !p.key.range) throw new Error('key')
    return normalized.lastIndexOf('\n', p.key.range[0] - 1) + 1
  })
  if (starts[0]) append('comments', normalized.slice(0, starts[0]))
  pairs.forEach((p, i) => {
    const name = String((p.key as { value: unknown }).value)
    const key = /^geo(?:data-|x-|site|ip|-)/.test(name)
      ? 'geo'
      : Object.hasOwn(titles, name)
        ? name
        : 'general'
    append(key, normalized.slice(starts[i], starts[i + 1] ?? normalized.length))
  })
  return result
}
export function lineCounts(before: string[], after: string[]): { added: number; removed: number } {
  const ids = new Map<string, string>()
  const encode = (lines: string[]) =>
    lines
      .map((line) => {
        if (!ids.has(line)) ids.set(line, String.fromCharCode(ids.size + 1))
        return ids.get(line)!
      })
      .join('')
  if (before.length + after.length > 60000) return { added: after.length, removed: before.length }
  const changes = diff(encode(before), encode(after), { scanLimit: 10000 })
  return changes.reduce(
    (count, change) => ({
      added: count.added + change.toB - change.fromB,
      removed: count.removed + change.toA - change.fromA,
    }),
    { added: 0, removed: 0 },
  )
}
export function summarizeBlocks(
  before: string,
  after: string,
): { changes: BlockChange[]; note?: string } {
  if (before === after) return { changes: [] }
  try {
    const a = blocks(before),
      b = blocks(after)
    const changes = [...new Set([...a.keys(), ...b.keys()])]
      .map((key) => ({
        key,
        title: titles[key],
        ...lineCounts(a.get(key) || [], b.get(key) || []),
      }))
      .filter((c) => c.added || c.removed)
    return {
      changes,
      ...(!changes.length ? { note: '仅调整格式或块顺序，请查看 YAML 差异。' } : {}),
    }
  } catch {
    const counts = lineCounts(before.split('\n'), after.split('\n'))
    return { changes: [{ key: 'yaml', title: 'YAML 配置', ...counts }] }
  }
}
