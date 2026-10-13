import { expect, test } from 'bun:test'
import { qualityFeedback } from '../src/lib/quality-feedback'

test('an empty evaluation does not promise publication eligibility', () => {
  const feedback = qualityFeedback({ versionNumber: 2, results: [], passed: 0, failed: 0 })
  expect(feedback.level).toBe('info')
  expect(feedback.message).toBe('Quality not evaluated')
})

test('warning-only failures differ from publication-blocking errors', () => {
  const result = { versionNumber: 2, passed: 0, failed: 1, results: [{ ruleName: 'Count', kind: 'row_count_min', passed: false, actual: '0 rows', message: null, severity: 'warn' }] }
  expect(qualityFeedback(result).message).toContain('passed with warnings')
  result.results[0].severity = 'error'
  expect(qualityFeedback(result).message).toContain('failed')
})
