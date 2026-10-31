import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Miniflare } from '../../../node_modules/.pnpm/miniflare@4.20260722.0/node_modules/miniflare/dist/src/index.js'

const MAIN = 'reelbam-video-jobs'
const DLQ = 'reelbam-video-jobs-dlq'

test('producer and consumer workers deliver a queue message into shared D1', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'reelbam-queue-'))
  const producer = `
    export default {
      async fetch(request, env) {
        const body = await request.json()
        await env.VIDEO_QUEUE.send(body)
        return new Response('sent')
      }
    }
  `
  const consumer = `
    export default {
      async queue(batch, env) {
        if (batch.queue !== ${JSON.stringify(MAIN)} && batch.queue !== ${JSON.stringify(DLQ)}) {
          throw new Error('unexpected queue ' + batch.queue)
        }
        for (const message of batch.messages) {
          await env.DB.prepare('insert into delivered(id, queue, body) values (?, ?, ?)').bind(message.body.eventId, batch.queue, JSON.stringify(message.body)).run()
          message.ack()
        }
      }
    }
  `
  const mf = new Miniflare({
    workers: [
      {
        name: 'reelbam-web',
        modules: true,
        script: producer,
        queueProducers: { VIDEO_QUEUE: MAIN },
        d1Databases: { DB: 'reelbam-shared' },
        compatibilityFlags: ['nodejs_compat'],
      },
      {
        name: 'reelbam-video-worker',
        modules: true,
        script: consumer,
        queueConsumers: {
          [MAIN]: { maxBatchTimeout: 0.05, maxRetries: 2, deadLetterQueue: DLQ },
          [DLQ]: { maxBatchTimeout: 0.05, maxRetries: 1 },
        },
        d1Databases: { DB: 'reelbam-shared' },
        compatibilityFlags: ['nodejs_compat'],
      },
    ],
  })
  try {
    const database = await mf.getD1Database('DB', 'reelbam-video-worker')
    await database.prepare('create table delivered(id text primary key, queue text, body text)').run()
    const response = await mf.dispatchFetch('http://example.com/send', {
      method: 'POST',
      body: JSON.stringify({
        messageVersion: 1,
        eventId: 'event-1',
        generationId: 'gen-1',
        eventType: 'start_submission',
        stepId: 'generate',
        attemptId: null,
      }),
    })
    assert.equal(response.status, 200)
    let row = null
    for (let attempt = 0; attempt < 20 && !row; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50))
      row = await database.prepare('select queue, body from delivered where id = ?').bind('event-1').first()
    }
    assert.ok(row, 'consumer did not persist the queue message')
    assert.equal(row.queue, MAIN)
    const body = JSON.parse(row.body)
    assert.equal(body.generationId, 'gen-1')
    assert.equal(body.eventType, 'start_submission')
    assert.equal(body.credits, undefined)
  }
  finally {
    await mf.dispose()
    rmSync(directory, { recursive: true, force: true })
  }
})
