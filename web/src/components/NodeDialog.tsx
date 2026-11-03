import { useState } from 'react'
import { ArrowDownToLine, ArrowLeft, ExternalLink, FileCode2 } from 'lucide-react'
import { Modal } from './Modal'
import { Editor } from './Editor'
import { nodeExamples } from '../lib/nodeExamples'
import { proxySource } from '../lib/nodeYaml'
import type { ProxyNode } from '../lib/document'
import './node-editor.css'

export default function NodeDialog({
  value,
  text,
  index,
  onClose,
  onSave,
}: {
  value: ProxyNode
  text: string
  index: number
  onClose: () => void
  onSave: (source: string) => void
}) {
  const existing = index >= 0
  const initialExample =
    nodeExamples.find((example) => example.type === value.type) || nodeExamples[0]
  const [source, setSource] = useState(() =>
    existing ? proxySource(text, index) : initialExample.yaml,
  )
  const [selected, setSelected] = useState(initialExample.id)
  const [previous, setPrevious] = useState<string | null>(null)
  const [error, setError] = useState('')
  const example = nodeExamples.find((item) => item.id === selected)!
  return (
    <Modal
      title={existing ? `编辑节点 · ${value.name}` : '添加自建节点'}
      size="wide"
      onClose={onClose}
    >
      <div className="node-yaml-layout modal-scroll">
        <div className="node-yaml-examples">
          <div className="action-row node-example-toolbar">
            <label className="control-row node-example-picker">
              <span>协议示例</span>
              <select
                aria-label="选择协议示例"
                value={selected}
                onChange={(event) => setSelected(event.target.value)}
              >
                {nodeExamples.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button small node-example-use"
              type="button"
              onClick={() => {
                setPrevious(source)
                setSource(example.yaml)
                setError('')
              }}
            >
              <ArrowDownToLine size={14} />
              填入示例
            </button>
            <a
              className="node-reference-link"
              href="https://wiki.metacubex.one/config/proxies/"
              target="_blank"
              rel="noreferrer"
            >
              协议文档
              <ExternalLink size={12} />
            </a>
          </div>
          <p className="node-example-note">{example.note} 填入会替换下方内容，可撤销。</p>
        </div>
        <section className="node-yaml-main" aria-label="节点编辑区">
          <div className="node-yaml-heading">
            <span>
              <FileCode2 size={16} />
              节点 YAML
            </span>
            <span className="node-yaml-format">YAML</span>
          </div>
          <p className="node-yaml-help">
            填写单个节点，无需 <code>proxies:</code> 或开头的 <code>-</code>。支持注释和原生字段。
          </p>
          <div className="node-yaml-code">
            <Editor
              value={source}
              onChange={(next) => {
                setSource(next)
                setError('')
              }}
              height="100%"
              ariaLabel="节点 YAML 编辑器"
              schemaContext="proxy"
            />
          </div>
          <div className="node-yaml-status">
            <span>输入时显示字段和备选值，悬停查看中文说明。可选字段去掉行首 # 后启用。</span>
            {previous !== null && (
              <button
                type="button"
                onClick={() => {
                  setSource(previous)
                  setPrevious(null)
                  setError('')
                }}
              >
                <ArrowLeft size={13} />
                撤销示例替换
              </button>
            )}
          </div>
          {error && (
            <p role="alert" className="node-yaml-error">
              {error}
            </p>
          )}
        </section>
      </div>
      <div className="modal-actions">
        <span className="modal-hint">更新草稿后，在页面顶部预览并确认保存。</span>
        <button className="button" onClick={onClose}>
          取消
        </button>
        <button
          className="button primary"
          onClick={() => {
            try {
              onSave(source)
            } catch (e) {
              setError(e instanceof Error ? e.message : '无法更新节点，请检查 YAML。')
            }
          }}
        >
          {existing ? '更新草稿' : '添加到草稿'}
        </button>
      </div>
    </Modal>
  )
}
