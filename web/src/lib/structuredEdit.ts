import { Document, isMap, isNode, isScalar, isSeq } from 'yaml'
import { analyze, appendItem, parse, patchValue, rename } from './document'
import type { Path, ProxyNode } from './document'

export { patchValue }

export function saveProxy(text: string, index: number, value: ProxyNode): string {
  const config = analyze(text).config
  if (!config) throw new Error('请先修复 YAML 结构。')
  if (!value.name?.trim() || !value.type) throw new Error('节点需要名称和协议。')
  const reserved = ['DIRECT', 'REJECT', 'REJECT-DROP', 'PASS', 'GLOBAL', 'COMPATIBLE']
  if (
    reserved.includes(value.name) ||
    [...(config.proxies || []), ...(config['proxy-groups'] || [])].some(
      (entry, i) => entry.name === value.name && i !== index,
    )
  )
    throw new Error('名称重复或占用保留名称。')
  if (index < 0) return appendItem(text, 'proxies', value)
  const original = config.proxies![index]
  let next = rename(text, 'proxies', index, value.name)
  // Rename may already have changed references inside this same object.
  const updated = { ...value }
  if (updated['dialer-proxy'] === original.name) updated['dialer-proxy'] = value.name
  next = patchValue(next, ['proxies', index], updated)
  return next
}

/** Selected-object source view. Editing comments/shared YAML must use the full source editor. */
export function editableSource(value: unknown): string {
  return new Document(value).toString({ lineWidth: 0 })
}
export function readObject(text: string): Record<string, unknown> {
  const doc = parse(text)
  if (doc.errors.length || !isMap(doc.contents)) throw new Error('请输入单个 YAML 对象。')
  const visit = (node: unknown): boolean => {
    if (!isNode(node)) return false
    if (node.comment || node.commentBefore || ('anchor' in node && node.anchor)) return true
    if (isMap(node)) return node.items.some((p) => visit(p.key) || visit(p.value))
    if (isSeq(node)) return node.items.some(visit)
    return !isScalar(node)
  }
  if (doc.comment || doc.commentBefore || visit(doc.contents))
    throw new Error('此处编辑字段值；注释、锚点和引用请在完整 YAML 源码中编辑。')
  return doc.toJS({ maxAliasCount: 100 }) as Record<string, unknown>
}

export function setObjectPath(value: unknown, path: Path, replacement: unknown): unknown {
  if (!path.length) return replacement
  const [key, ...rest] = path
  if (Array.isArray(value)) {
    const next = [...value]
    next[Number(key)] = setObjectPath(next[Number(key)], rest, replacement)
    return next
  }
  const next = { ...(value && typeof value === 'object' ? value : {}) } as Record<string, unknown>
  if (!rest.length && replacement === undefined) delete next[key]
  else
    Object.defineProperty(next, key, {
      value: setObjectPath(next[key], rest, replacement),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  return next
}
