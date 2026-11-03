import { Document, isAlias, isMap, isNode, isSeq, type YAMLMap } from 'yaml'
import { analyze, appendItem, parse, rename } from './document'
import type { ProxyNode } from './document'

function shared(node: unknown): boolean {
  if (isAlias(node) || (isNode(node) && 'anchor' in node && node.anchor)) return true
  if (isMap(node))
    return node.items.some((p) => String(p.key) === '<<' || shared(p.key) || shared(p.value))
  return isSeq(node) && node.items.some(shared)
}

export function proxySource(text: string, index: number): string {
  const node = parse(text).getIn(['proxies', index], true)
  if (!isMap(node))
    return new Document(analyze(text).config?.proxies?.[index] || {}).toString({ lineWidth: 0 })
  const doc = new Document()
  const mapping = node.clone() as YAMLMap
  doc.contents = mapping
  // Comments preceding the sequence item stay in the full document, outside
  // the selected mapping's range. Comments inside the mapping remain editable.
  mapping.commentBefore = undefined
  mapping.flow = false
  return doc.toString({ lineWidth: 0, verifyAliasOrder: false })
}

export function saveProxyYaml(text: string, index: number, source: string): string {
  if (index >= 0 && source === proxySource(text, index)) return text
  const input = parse(source)
  if (input.errors.length) throw new Error(input.errors[0].message)
  if (!isMap(input.contents))
    throw new Error('请输入单个节点的 YAML，不需要 proxies: 或开头的列表符号。')
  if (shared(input.contents)) throw new Error('共享锚点、合并键和引用请在完整 YAML 源码中编辑。')
  const value = input.toJS({ maxAliasCount: 100 }) as ProxyNode
  if (typeof value.name !== 'string' || !value.name.trim())
    throw new Error('name 需要填写非空的节点名称。')
  if (typeof value.type !== 'string' || !value.type.trim())
    throw new Error('type 需要填写协议名称。')
  const config = analyze(text).config
  if (!config) throw new Error('请先修复完整 YAML 的结构。')
  if (
    ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'GLOBAL', 'COMPATIBLE'].includes(value.name) ||
    config.proxies?.some((p, i) => i !== index && p.name === value.name) ||
    config['proxy-groups']?.some((p) => p.name === value.name)
  )
    throw new Error('节点名称重复或占用了保留名称。')

  const replacement = input.contents.clone() as YAMLMap
  if (input.commentBefore)
    replacement.commentBefore = [input.commentBefore, replacement.commentBefore]
      .filter(Boolean)
      .join('\n')
  if (input.comment)
    replacement.comment = [replacement.comment, input.comment].filter(Boolean).join('\n')
  if (index < 0) return appendItem(text, 'proxies', replacement)

  const original = parse(text)
  const list = original.get('proxies', true)
  const item = original.getIn(['proxies', index], true)
  if (
    !isSeq(list) ||
    list.anchor ||
    !isMap(item) ||
    shared(item) ||
    (isMap(original.contents) &&
      (original.contents.anchor || original.contents.items.some((p) => String(p.key) === '<<')))
  )
    throw new Error('共享节点请在完整 YAML 源码中编辑，避免改变其他引用。')

  let next = rename(text, 'proxies', index, value.name)
  const updated = parse(next).getIn(['proxies', index], true)
  if (!isMap(updated) || !updated.range) throw new Error('无法定位原节点，请重新打开编辑器。')
  if (value['dialer-proxy'] === config.proxies![index].name)
    replacement.set('dialer-proxy', value.name)
  replacement.flow = !!list.flow
  const doc = new Document()
  doc.contents = replacement
  const [start, , end] = updated.range
  const indent = start - next.lastIndexOf('\n', start - 1) - 1
  const nl = next.includes('\r\n') ? '\r\n' : '\n'
  const fragment = doc
    .toString({ lineWidth: 0 })
    .trimEnd()
    .split('\n')
    .map((line, i) => (i ? ' '.repeat(indent) : '') + line)
    .join(nl)
  next = next.slice(0, start) + fragment + (next[end - 1] === '\n' ? nl : '') + next.slice(end)
  if (parse(next).errors.length) throw new Error('此节点的布局需要在完整 YAML 源码中调整。')
  return next
}
