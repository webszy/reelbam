import assert from 'node:assert/strict'
import test from 'node:test'
import { consumeQueueBatch } from '../src/queue.ts'
import { MAIN_QUEUE_NAME } from '../../../packages/data/src/video/protocol.ts'

test('a failed queue item retries without replaying successful batch items', async () => {
  const decisions = []
  const calls = []
  const messages = ['first', 'bad', 'last'].map(id => ({
    body: { messageVersion: 1, eventId: id, generationId: 'gen', eventType: 'start_submission', stepId: 'generate', attemptId: null },
    ack() { decisions.push([id, 'ack']) },
    retry(options) { decisions.push([id, 'retry', options.delaySeconds]) },
  }))
  await consumeQueueBatch({ queue: MAIN_QUEUE_NAME, messages }, {}, async (_env, body) => {
    calls.push(body.eventId)
    if (body.eventId === 'bad') throw new Error('private error details must not be logged')
    return 'ack'
  })
  assert.deepEqual(calls, ['first', 'bad', 'last'])
  assert.deepEqual(decisions, [['first', 'ack'], ['bad', 'retry', 30], ['last', 'ack']])
})
