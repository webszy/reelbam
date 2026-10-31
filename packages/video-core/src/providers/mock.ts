import type { JsonObject, ProviderJobHandle, RouteSnapshot } from '@reelbam/video-contracts/internal'
import type { Clock, ProviderAdapter, ProviderCost, ProviderErrorCode, ProviderSubmission, SubmitResult } from '../provider.ts'
import { ProviderError } from '../provider.ts'
import { assertInputMatchesCapability, validateGenerationInput } from '../validation.ts'
import { frozenCopy, isNonBlank } from '../value.ts'

export interface MockScenario {
  readonly submit: 'accepted' | 'rejected' | 'unknown'
  readonly outcome: 'completed' | 'failed' | 'hang'
  readonly completeAfterMs: number
  readonly statusUnavailableForMs: number
  readonly recovery: 'accepted' | 'not_found' | 'unknown'
  readonly failureCode: ProviderErrorCode
  readonly fixtureId: string
}

export interface MockProviderConfig {
  /** 必须显式传入；不读取 process.env 或 Cloudflare Env。 */
  readonly environment: string
  readonly providerId: string
  readonly adapterVersion?: string
  readonly scenario?: Partial<MockScenario>
}

interface MockMetadata extends JsonObject {
  readonly kind: 'reelbam-mock-job'
  readonly version: 1
  readonly snapshotIdentity: string
  readonly submissionKey: string
  readonly submittedAtMs: number
  readonly readyAtMs: number
  readonly unavailableUntilMs: number
  readonly outcome: MockScenario['outcome']
  readonly recovery: MockScenario['recovery']
  readonly failureCode: ProviderErrorCode
  readonly fixtureId: string
}

const ERROR_CODES: readonly ProviderErrorCode[] = [
  'authentication_error', 'rate_limited', 'invalid_input', 'provider_unavailable',
  'provider_timeout', 'content_policy', 'unknown',
]

const DEFAULT_SCENARIO: MockScenario = {
  submit: 'accepted', outcome: 'completed', completeAfterMs: 3000,
  statusUnavailableForMs: 0, recovery: 'accepted', failureCode: 'content_policy',
  fixtureId: 'reelbam/mock-video-v1',
}

const MOCK_COST: ProviderCost = Object.freeze({ kind: 'actual', amountMicros: 0, currency: 'USD', source: 'mock' })

/** 对同一快照产生稳定身份；不使用随机数、网络或当前默认路线。不是持久化签名。 */
function identity(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(identity).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${identity(child)}`).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new ProviderError('invalid_input', 'Mock snapshots must contain JSON values')
  return encoded
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function createMockProvider(config: MockProviderConfig, clock: Clock): ProviderAdapter {
  if (config.environment !== 'development' && config.environment !== 'test') {
    throw new ProviderError('invalid_input', 'Mock Provider requires an explicit development or test environment')
  }
  if (!isNonBlank(config.providerId)) throw new ProviderError('invalid_input', 'Mock Provider ID is required')
  const providerId = config.providerId
  const adapterVersion = config.adapterVersion ?? 'mock-v1'
  const scenario = frozenCopy({ ...DEFAULT_SCENARIO, ...config.scenario })
  if (!isNonBlank(adapterVersion) || !['accepted', 'rejected', 'unknown'].includes(scenario.submit)
    || !['completed', 'failed', 'hang'].includes(scenario.outcome)
    || !['accepted', 'not_found', 'unknown'].includes(scenario.recovery)
    || !nonNegativeInteger(scenario.completeAfterMs) || !nonNegativeInteger(scenario.statusUnavailableForMs)
    || !ERROR_CODES.includes(scenario.failureCode) || !isNonBlank(scenario.fixtureId)) {
    throw new ProviderError('invalid_input', 'Invalid Mock scenario')
  }

  function assertRoute(snapshot: RouteSnapshot): void {
    if (snapshot.schemaVersion !== 1 || snapshot.providerId !== providerId || snapshot.adapterVersion !== adapterVersion
      || snapshot.model.id !== snapshot.input.modelId || !isNonBlank(snapshot.providerModelId)) {
      throw new ProviderError('invalid_input', 'Snapshot does not belong to this Mock adapter')
    }
    assertInputMatchesCapability(validateGenerationInput(snapshot.input), snapshot.capability)
  }

  function assertSubmission(input: ProviderSubmission): void {
    assertRoute(input.snapshot)
    if (!isNonBlank(input.submissionKey) || !nonNegativeInteger(input.submittedAtMs)) {
      throw new ProviderError('invalid_input', 'Persist a stable submission key and timestamp before submit')
    }
  }

  function readMetadata(value: JsonObject, snapshot: RouteSnapshot): MockMetadata {
    assertRoute(snapshot)
    if (value.kind !== 'reelbam-mock-job' || value.version !== 1 || value.snapshotIdentity !== identity(snapshot)
      || !isNonBlank(value.submissionKey) || !nonNegativeInteger(value.submittedAtMs)
      || !nonNegativeInteger(value.readyAtMs) || !nonNegativeInteger(value.unavailableUntilMs)
      || value.readyAtMs < value.submittedAtMs || value.unavailableUntilMs < value.submittedAtMs
      || !['completed', 'failed', 'hang'].includes(String(value.outcome))
      || !['accepted', 'not_found', 'unknown'].includes(String(value.recovery))
      || !ERROR_CODES.includes(value.failureCode as ProviderErrorCode) || !isNonBlank(value.fixtureId)) {
      throw new ProviderError('invalid_input', 'Invalid or mismatched persisted Mock metadata')
    }
    return frozenCopy(value as MockMetadata)
  }

  function handle(snapshot: RouteSnapshot, metadata: MockMetadata): ProviderJobHandle {
    return frozenCopy({
      providerId, providerModelId: snapshot.providerModelId, adapterVersion,
      jobId: `mock:${encodeURIComponent(providerId)}:${encodeURIComponent(metadata.submissionKey)}`,
      metadata,
    })
  }

  async function evaluate(input: ProviderSubmission): Promise<SubmitResult> {
    assertSubmission(input)
    if (scenario.submit === 'rejected') {
      return { kind: 'rejected' as const, failure: { code: scenario.failureCode, message: 'Mock submission rejected; no job created' } }
    }
    const metadata: MockMetadata = {
      kind: 'reelbam-mock-job', version: 1, snapshotIdentity: identity(input.snapshot),
      submissionKey: input.submissionKey, submittedAtMs: input.submittedAtMs,
      readyAtMs: input.submittedAtMs + scenario.completeAfterMs,
      unavailableUntilMs: input.submittedAtMs + scenario.statusUnavailableForMs,
      outcome: scenario.outcome, recovery: scenario.recovery, failureCode: scenario.failureCode,
      fixtureId: scenario.fixtureId,
    }
    // 时间和场景随 metadata 保存；重新构造 adapter 后不重新起算。
    const saved = readMetadata(metadata, input.snapshot)
    if (scenario.submit === 'unknown') return { kind: 'unknown' as const, recoveryMetadata: saved }
    return { kind: 'accepted' as const, handle: handle(input.snapshot, saved) }
  }

  return Object.freeze({
    id: providerId,
    adapterVersion,
    submissionIdempotency: 'deterministic_mock' as const,
    projectSubmission: evaluate,
    submit: evaluate,
    async getStatus(saved: ProviderJobHandle, snapshot: RouteSnapshot) {
      const metadata = readMetadata(saved.metadata, snapshot)
      const expected = handle(snapshot, metadata)
      if (saved.providerId !== providerId || saved.adapterVersion !== adapterVersion
        || saved.providerModelId !== snapshot.providerModelId || saved.jobId !== expected.jobId) {
        throw new ProviderError('invalid_input', 'Mock job handle does not match its route')
      }
      const now = clock.nowMs()
      if (!nonNegativeInteger(now)) throw new ProviderError('invalid_input', 'Invalid injected clock')
      if (now < metadata.unavailableUntilMs) {
        throw new ProviderError('provider_unavailable', 'Mock status query is temporarily unavailable')
      }
      if (metadata.outcome === 'hang' || now < metadata.readyAtMs) return { state: 'pending' as const }
      if (metadata.outcome === 'failed') {
        return { state: 'failed' as const, failure: { code: metadata.failureCode, message: 'Mock generation failed' }, cost: MOCK_COST }
      }
      return { state: 'completed' as const, output: { kind: 'fixture' as const, fixtureId: metadata.fixtureId }, cost: MOCK_COST }
    },
    async recoverSubmission(input: ProviderSubmission, recoveryMetadata: JsonObject) {
      assertSubmission(input)
      const metadata = readMetadata(recoveryMetadata, input.snapshot)
      if (metadata.submissionKey !== input.submissionKey || metadata.submittedAtMs !== input.submittedAtMs) {
        throw new ProviderError('invalid_input', 'Recovery must use the original submission')
      }
      if (metadata.recovery === 'accepted') return { kind: 'accepted' as const, handle: handle(input.snapshot, metadata) }
      if (metadata.recovery === 'not_found') return { kind: 'not_found' as const }
      return { kind: 'unknown' as const, recoveryMetadata: metadata }
    },
  })
}
