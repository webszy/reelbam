import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InvalidTransitionError, isTerminal, transitionGeneration } from '../src/state-machine.ts'
import type { GenerationEvent } from '../src/state-machine.ts'

describe('纯任务状态机', () => {
  it('合法成功流程必须先受理、查询完成、保存输出', () => {
    assert.equal(transitionGeneration('queued', 'start_submission'), 'submitting')
    assert.equal(transitionGeneration('submitting', 'submission_accepted'), 'processing')
    assert.equal(transitionGeneration('processing', 'provider_pending'), 'processing')
    assert.equal(transitionGeneration('processing', 'provider_completed'), 'storing')
    assert.equal(transitionGeneration('storing', 'output_stored'), 'succeeded')
    assert.throws(() => transitionGeneration('queued', 'output_stored'), InvalidTransitionError)
    assert.throws(() => transitionGeneration('processing', 'output_stored'), InvalidTransitionError)
    assert.throws(() => transitionGeneration('queued', 'toString' as GenerationEvent), InvalidTransitionError)
  })

  it('明确拒绝/终态失败可失败；提交异常或 unknown 必须先恢复或人工处理', () => {
    assert.equal(transitionGeneration('submitting', 'submission_rejected'), 'failed')
    assert.equal(transitionGeneration('processing', 'provider_failed'), 'failed')
    assert.equal(transitionGeneration('submitting', 'submission_unknown'), 'submission_unknown')
    assert.equal(transitionGeneration('submitting', 'submission_call_failed'), 'submission_unknown')
    assert.equal(transitionGeneration('submission_unknown', 'recovery_unavailable'), 'submission_unknown')
    assert.equal(transitionGeneration('submission_unknown', 'recovered_accepted'), 'processing')
    assert.equal(transitionGeneration('submission_unknown', 'recovery_confirmed_absent'), 'queued')
    assert.equal(transitionGeneration('submission_unknown', 'deadline_reached'), 'needs_review')
    assert.equal(transitionGeneration('needs_review', 'recovery_unavailable'), 'needs_review')
    assert.equal(transitionGeneration('needs_review', 'recovery_confirmed_absent'), 'failed')
    assert.equal(transitionGeneration('needs_review', 'recovered_accepted'), 'processing')
    assert.throws(() => transitionGeneration('submission_unknown', 'provider_failed'), InvalidTransitionError)
    assert.throws(() => transitionGeneration('submission_unknown', 'start_submission'), InvalidTransitionError)
    assert.equal(isTerminal('needs_review'), false)
  })

  it('已受理轮询失败不重新 submit，存储失败不重新生成', () => {
    assert.equal(transitionGeneration('processing', 'poll_call_failed'), 'processing')
    assert.equal(transitionGeneration('processing', 'deadline_reached'), 'needs_review')
    assert.equal(transitionGeneration('storing', 'storage_call_failed'), 'storing')
    assert.equal(transitionGeneration('storing', 'storage_irrecoverable'), 'failed')
    for (const state of ['processing', 'storing'] as const) {
      assert.throws(() => transitionGeneration(state, 'start_submission'), InvalidTransitionError)
      assert.throws(() => transitionGeneration(state, 'submission_accepted'), InvalidTransitionError)
    }
  })

  it('两种终态拒绝所有迟到事件，不能互相覆盖或重新开始', () => {
    const events: readonly GenerationEvent[] = [
      'start_submission', 'submission_accepted', 'submission_rejected', 'submission_unknown',
      'submission_call_failed', 'recovered_accepted', 'recovery_confirmed_absent', 'recovery_unavailable',
      'provider_pending', 'provider_completed', 'provider_failed', 'poll_call_failed',
      'output_stored', 'storage_call_failed', 'storage_irrecoverable', 'deadline_reached',
    ]
    for (const terminal of ['succeeded', 'failed'] as const) {
      assert.equal(isTerminal(terminal), true)
      for (const event of events) assert.throws(() => transitionGeneration(terminal, event), InvalidTransitionError)
    }
  })
})
