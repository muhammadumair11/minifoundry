import type { EvaluateQualityResponse } from './foundry-types'

/** Match the publication policy, including empty and warning-only evaluations. */
export function qualityFeedback(result: EvaluateQualityResponse) {
  const failures = result.results.filter((rule) => !rule.passed)
  if (result.qualityState === 'not_evaluated' || result.results.length === 0) {
    return { level: 'info' as const, message: 'Quality not evaluated', description: 'Add and enable a quality rule, then evaluate again.' }
  }
  if (failures.length) {
    const blocked = failures.some((rule) => rule.severity === 'error')
    return {
      level: 'warning' as const,
      message: `Quality ${blocked ? 'failed' : 'passed with warnings'} on v${result.versionNumber}`,
      description: failures.map((rule) => `${rule.ruleName}: ${rule.actual ?? rule.message ?? 'failed'}`).join(' · '),
    }
  }
  return { level: 'success' as const, message: `Quality passed — ${result.passed} rule${result.passed === 1 ? '' : 's'} ok on v${result.versionNumber}`, description: undefined }
}
