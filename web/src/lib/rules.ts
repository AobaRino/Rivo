import type { Config, Path } from './document'

// Target position follows Mihomo's rule grammar. Regex/logic payloads can contain
// commas; ordinary rules have parameters after the target (including `src`).
export function ruleParts(value: string) {
  const parts = value.split(',')
  const type = parts[0].trim().toUpperCase()
  const index =
    type === 'MATCH'
      ? 1
      : [
            'NOT',
            'OR',
            'AND',
            'SUB-RULE',
            'DOMAIN-REGEX',
            'PROCESS-NAME-REGEX',
            'PROCESS-PATH-REGEX',
          ].includes(type)
        ? parts.length - 1
        : 2
  return {
    parts,
    type,
    index,
    target: parts[index]?.trim() || '',
    payload: parts.slice(1, index).join(',').trim(),
  }
}

export function ruleRows(config: Config): { value: string; path: Path; label: string }[] {
  return [
    ...(config.rules || []).map((value, i) => ({
      value,
      path: ['rules', i],
      label: `第 ${i + 1} 条规则`,
    })),
    ...Object.entries(config['sub-rules'] || {}).flatMap(([name, rules]) =>
      rules.map((value, i) => ({
        value,
        path: ['sub-rules', name, i],
        label: `子规则 ${name} / ${i + 1}`,
      })),
    ),
  ]
}

export function canEditSimpleRule(value: string): boolean {
  return (
    /^MATCH,[^,]+$/.test(value) ||
    /^(DOMAIN-SUFFIX|DOMAIN|DOMAIN-KEYWORD|IP-CIDR|IP-CIDR6|GEOIP|RULE-SET),[^,]+,[^,]+(?:,no-resolve)?$/.test(
      value,
    )
  )
}
