import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { JsonObject, ProviderJobHandle } from '../../video-contracts/src/internal.ts'
import type { ProviderCost, ProviderErrorCode, ProviderSubmission, SubmitResult } from '../src/provider.ts'
import { ProviderError } from '../src/provider.ts'
import { createMockProvider } from '../src/providers/mock.ts'
import { setup } from './fixtures.ts'

const persisted = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function accepted(result: SubmitResult): ProviderJobHandle {
  assert.equal(result.kind, 'accepted')
  if (result.kind !== 'accepted') throw new Error('Expected accepted fixture')
  return result.handle
}

describe('可持久化 Mock Provider', () => {
  it('accepted → pending → completed；仅有 fixture 引用和明确 0 成本', async () => {
    const { adapter, snapshot, time } = setup()
    const submission: ProviderSubmission = { snapshot, submissionKey: 'generation:1:step:1', submittedAtMs: time.value }
    const handle = accepted(await adapter.submit(submission))
    assert.deepEqual(await adapter.submit(submission), { kind: 'accepted', handle })
    assert.deepEqual(await adapter.getStatus(handle, snapshot), { state: 'pending' })
    time.value += 3000
    assert.deepEqual(await adapter.getStatus(handle, snapshot), {
      state: 'completed', output: { kind: 'fixture', fixtureId: 'reelbam/mock-video-v1' },
      cost: { kind: 'actual', amountMicros: 0, currency: 'USD', source: 'mock' },
    })
    const unknownCost: ProviderCost = { kind: 'unknown' }
    assert.equal('amountMicros' in unknownCost, false)
  })

  it('重建 adapter 使用原 handle/metadata，不能随新配置重置任务结果/时间', async () => {
    const { adapter, snapshot, time } = setup({ scenario: { outcome: 'failed', failureCode: 'content_policy', completeAfterMs: 20 } })
    const handle = persisted(accepted(await adapter.submit({ snapshot, submissionKey: 'restart', submittedAtMs: time.value })))
    const savedSnapshot = persisted(snapshot)
    time.value += 20
    const restarted = createMockProvider({ environment: 'test', providerId: snapshot.providerId, scenario: { outcome: 'completed', completeAfterMs: 999999 } }, { nowMs: () => time.value })
    const status = await restarted.getStatus(handle, savedSnapshot)
    assert.equal(status.state, 'failed')
    if (status.state !== 'failed') throw new Error('Expected failed fixture')
    assert.equal(status.failure.code, 'content_policy')
    assert.equal(status.cost.kind, 'actual')
  })

  it('rejected 确认没有任务；unknown 保留恢复信息且不当作失败', async () => {
    const rejection = setup({ scenario: { submit: 'rejected', failureCode: 'invalid_input' } })
    assert.deepEqual(await rejection.adapter.submit({ snapshot: rejection.snapshot, submissionKey: 'reject', submittedAtMs: 1000 }), {
      kind: 'rejected', failure: { code: 'invalid_input', message: 'Mock submission rejected; no job created' },
    })
    const uncertain = setup({ scenario: { submit: 'unknown', recovery: 'accepted' } })
    const submission = { snapshot: uncertain.snapshot, submissionKey: 'unknown', submittedAtMs: 1000 }
    const result = await uncertain.adapter.submit(submission)
    assert.equal(result.kind, 'unknown')
    if (result.kind !== 'unknown') throw new Error('Expected unknown fixture')
    const restarted = createMockProvider({ environment: 'test', providerId: submission.snapshot.providerId }, uncertain.clock)
    const recovered = await restarted.recoverSubmission!(persisted(submission), persisted(result.recoveryMetadata))
    assert.equal(recovered.kind, 'accepted')
    if (recovered.kind !== 'accepted') throw new Error('Expected recovered handle')
    uncertain.time.value = 4000
    assert.equal((await restarted.getStatus(recovered.handle, submission.snapshot)).state, 'completed')
    await assert.rejects(restarted.recoverSubmission!({ ...submission, submissionKey: 'changed' }, result.recoveryMetadata), ProviderError)
  })

  it('恢复可以确认未接单或继续不明确，不自动重提', async () => {
    for (const recovery of ['not_found', 'unknown'] as const) {
      const { adapter, snapshot } = setup({ scenario: { submit: 'unknown', recovery } })
      const submission = { snapshot, submissionKey: recovery, submittedAtMs: 1000 }
      const result = await adapter.submit(submission)
      if (result.kind !== 'unknown') throw new Error('Expected unknown fixture')
      assert.equal((await adapter.recoverSubmission!(submission, result.recoveryMetadata)).kind, recovery)
    }
  })

  it('查询临时异常与上游 failed 分开；hang 不需要定时器', async () => {
    const { adapter, snapshot, time } = setup({ scenario: { statusUnavailableForMs: 100, completeAfterMs: 200 } })
    const handle = accepted(await adapter.submit({ snapshot, submissionKey: 'temporary', submittedAtMs: 1000 }))
    await assert.rejects(adapter.getStatus(handle, snapshot), (e: unknown) => e instanceof ProviderError && e.code === 'provider_unavailable')
    time.value = 1100
    assert.deepEqual(await adapter.getStatus(handle, snapshot), { state: 'pending' })
    time.value = 1200
    assert.equal((await adapter.getStatus(handle, snapshot)).state, 'completed')
    const hanging = setup({ scenario: { outcome: 'hang' } })
    const hungHandle = accepted(await hanging.adapter.submit({ snapshot: hanging.snapshot, submissionKey: 'hang', submittedAtMs: 1000 }))
    hanging.time.value = 10_000_000
    assert.deepEqual(await hanging.adapter.getStatus(hungHandle, hanging.snapshot), { state: 'pending' })
  })

  it('拒绝错误 Route/handle/metadata 和不明确的启用环境', async () => {
    for (const environment of ['production', 'staging', 'preview', '', 'Development']) {
      assert.throws(() => createMockProvider({ environment, providerId: 'a' }, { nowMs: () => 1000 }), ProviderError)
    }
    const { adapter, snapshot } = setup()
    const handle = accepted(await adapter.submit({ snapshot, submissionKey: 'guard', submittedAtMs: 1000 }))
    for (const bad of [
      { ...handle, providerId: 'mock-provider-b' }, { ...handle, jobId: 'other' },
      { ...handle, metadata: {} }, { ...handle, metadata: { ...handle.metadata, readyAtMs: -1 } },
    ]) await assert.rejects(adapter.getStatus(bad, snapshot), ProviderError)
    await assert.rejects(adapter.getStatus(handle, { ...snapshot, revision: 2 }), ProviderError)
    await assert.rejects(adapter.submit({ snapshot, submissionKey: '', submittedAtMs: 1000 }), ProviderError)
    await assert.rejects(adapter.submit({ snapshot, submissionKey: 'key', submittedAtMs: NaN }), ProviderError)
    const badRecovery: JsonObject = { ...handle.metadata, snapshotIdentity: 'wrong' }
    await assert.rejects(adapter.recoverSubmission!({ snapshot, submissionKey: 'guard', submittedAtMs: 1000 }, badRecovery), ProviderError)
    assert.equal(adapter.cancel, undefined)
  })

  it('调用错误分类不包含自动重提许可', () => {
    const codes: readonly ProviderErrorCode[] = ['authentication_error', 'rate_limited', 'invalid_input', 'provider_unavailable', 'provider_timeout', 'content_policy', 'unknown']
    for (const code of codes) {
      const error = new ProviderError(code, 'sanitized message')
      assert.equal(error.code, code)
      assert.equal('retryable' in error, false)
      assert.equal('resubmitAllowed' in error, false)
    }
  })
})
