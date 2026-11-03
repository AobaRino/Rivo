import { expect, it } from 'vitest'
import { formatBytes } from './metrics'

it('distinguishes an unavailable sample from actual zero traffic', () => {
  expect(formatBytes(null, '/s').value).toBe('—')
  expect(formatBytes(undefined).value).toBe('—')
  expect(formatBytes(0, '/s')).toEqual({ value: '0', unit: 'B/s' })
  expect(formatBytes(1536, '/s')).toEqual({ value: '1.5', unit: 'KiB/s' })
  expect(formatBytes(100 * 1024 ** 2)).toEqual({ value: '100.0', unit: 'MiB' })
  expect(formatBytes(NaN).value).toBe('—')
  expect(formatBytes(-1).value).toBe('—')
})
