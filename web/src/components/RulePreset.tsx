import { useMemo, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { Config } from '../lib/document'
import {
  applyMetaRulePreset,
  defaultPresetProxy,
  metaRuleSets,
  metaPresetRules,
  metaRulesSource,
  planMetaServices,
  presetExits,
  presetProxyGroups,
  readServiceSelections,
} from '../lib/rulePresets'
import { serviceRules } from '../lib/serviceRules'
import type { ServiceSelections } from '../lib/serviceRules'
import { ruleParts } from '../lib/rules'
import { ServicePicker } from './ServicePicker'
import { Modal } from './Modal'
import {
  extraProviderName,
  needsMetaRuleExtras,
  upgradeMetaRuleExtras,
} from '../lib/metaRuleExtras'

type Props = {
  config: Config
  disabled: boolean
  onEdit: (fn: (text: string) => string) => boolean
}

export function RulePreset({ config, disabled, onEdit }: Props) {
  const [open, setOpen] = useState(false)
  const selected = readServiceSelections(config)
  const needsExtras = needsMetaRuleExtras(config)
  return (
    <>
      <section className="panel rule-preset" aria-labelledby="rule-preset-heading">
        <div className="panel-heading">
          <div>
            <h2 id="rule-preset-heading">MetaCubeX 规则预设</h2>
            <p>国内直连、国外代理。可为 Steam、微软、AI、流媒体等服务单独选择出口。</p>
          </div>
          <div className="action-row">
            {needsExtras && (
              <button
                className="button small"
                disabled={disabled}
                onClick={() => onEdit(upgradeMetaRuleExtras)}
              >
                补全关键词与正则
              </button>
            )}
            <button
              className="button primary small"
              disabled={disabled}
              onClick={() => setOpen(true)}
            >
              配置分流预设
            </button>
          </div>
        </div>
        <div className="rule-preset-info">
          <span>默认每 24 小时更新</span>
          <span>{needsExtras ? '可补全关键词与正则' : '支持关键词与正则'}</span>
          <span>已启用 {Object.keys(selected).length} 个服务分组</span>
          <a href={metaRulesSource} target="_blank" rel="noreferrer">
            查看规则来源 <ExternalLink size={12} />
          </a>
        </div>
        {!!Object.keys(selected).length && (
          <div className="service-preset-current" aria-label="当前服务默认出口">
            {serviceRules
              .filter((service) => Object.hasOwn(selected, service.id))
              .map((service) => (
                <span key={service.id}>
                  {service.name}
                  <span>→</span>
                  <strong>{selected[service.id]}</strong>
                </span>
              ))}
          </div>
        )}
      </section>
      {open && (
        <PresetDialog
          config={config}
          disabled={disabled}
          onEdit={onEdit}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function PresetDialog({ config, disabled, onEdit, onClose }: Props & { onClose: () => void }) {
  const [proxy, setProxy] = useState(() => defaultPresetProxy(config))
  const [selected, setSelected] = useState<ServiceSelections>(() => readServiceSelections(config))
  const [error, setError] = useState('')
  const groups = presetProxyGroups(config)
  const plan = useMemo(() => {
    try {
      return { value: planMetaServices(config, selected), error: '' }
    } catch (e) {
      return { value: null, error: e instanceof Error ? e.message : '无法生成分组。' }
    }
  }, [config, selected])
  const basicRules = metaPresetRules(proxy)
  const entries = [...metaRuleSets, ...(plan.value?.providers || [])]
  const baseRules = [
    ...basicRules.slice(0, 2),
    ...(plan.value?.rules || []),
    ...basicRules.slice(2),
  ]
  const rules = baseRules.flatMap((rule) => {
    const parts = ruleParts(rule)
    return entries.some((entry) => entry.name === parts.payload && entry.behavior === 'domain')
      ? [
          rule,
          rule.replace(
            `RULE-SET,${parts.payload},`,
            `RULE-SET,${extraProviderName(parts.payload)},`,
          ),
        ]
      : [rule]
  })
  const providerLabels = new Map(
    entries.flatMap((entry): [string, string][] => [
      [entry.name, entry.label],
      ...(entry.behavior === 'domain'
        ? [[extraProviderName(entry.name), `${entry.label} · 关键词与正则`] as [string, string]]
        : []),
    ]),
  )
  const canGenerate = !plan.error && groups.some((group) => group.name === proxy)
  return (
    <Modal title="配置 MetaCubeX 分流预设" onClose={onClose} size="large">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          setError('')
          if (
            onEdit((text) => {
              try {
                return applyMetaRulePreset(text, proxy, selected)
              } catch (e) {
                setError(e instanceof Error ? e.message : '无法生成预设。')
                throw e
              }
            })
          )
            onClose()
        }}
      >
        <div className="modal-form">
          <label className="field">
            <span>默认代理组</span>
            <select
              aria-label="预设国外代理组"
              value={proxy}
              disabled={disabled || !groups.length}
              onChange={(e) => setProxy(e.target.value)}
            >
              {!groups.length && <option value="">暂无代理组</option>}
              {groups.map((group) => (
                <option key={group.name} value={group.name}>
                  {group.name}
                </option>
              ))}
            </select>
            <small>
              {groups.length
                ? '未单独分组的国外流量、其余流量及规则集下载使用此组。局域网与国内基础规则保持直连。'
                : '请先在代理组页面创建可用的代理组。'}
            </small>
          </label>
          <ServicePicker
            selected={selected}
            onChange={setSelected}
            exits={presetExits(config)}
            proxy={proxy}
            disabled={disabled}
          />
          <details className="rule-preset-preview">
            <summary>查看生成顺序 · {rules.length} 条规则</summary>
            <p className="rule-preset-note">
              局域网 → 国内服务与下载例外 → 具体服务 → 国内外基础规则 → 其余流量
            </p>
            <ol aria-label="预设规则顺序">
              {rules.map((rule, i) => {
                const parts = ruleParts(rule)
                return (
                  <li key={i}>
                    <span>
                      {parts.type === 'MATCH'
                        ? '其余流量'
                        : providerLabels.get(parts.payload) || parts.payload}
                    </span>
                    <strong>{parts.target || '待选择'}</strong>
                  </li>
                )
              })}
            </ol>
          </details>
          <p className="rule-preset-note">
            域名与 IP 使用 MRS，关键词与正则使用 Classical 补充集，默认每 24 小时更新。 补充集由
            Rivo 每天从 MetaCubeX 提取，下载与更新由 Mihomo 执行。不包含广告拦截。
            仅补全现有预设时，可在卡片上点击「补全关键词与正则」，保留现有规则顺序和出口。
          </p>
          <p className="rule-preset-impact">
            将替换当前 {config.rules?.length || 0}{' '}
            条主规则，并设置为规则模式。取消勾选会移除对应分流及未被引用的自动生成项；其他配置仍在使用的项会保留。
            保存前可查看代理组、规则集与分流规则的摘要和 YAML 差异。
          </p>
          {(error || plan.error) && (
            <p className="rule-provider-error" role="alert">
              {error || plan.error}
            </p>
          )}
        </div>
        <div className="modal-actions">
          <span className="modal-hint">
            {Object.keys(selected).length} 个服务分组 · 每 24 小时更新
          </span>
          <button type="button" className="button" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="button primary" disabled={disabled || !canGenerate}>
            生成到草稿
          </button>
        </div>
      </form>
    </Modal>
  )
}
