import './webhook-globals.ts'
import { parentPort, workerData } from 'node:worker_threads'
import { consumeCreditsForGeneration } from '../src/credits/consume.ts'
import { returnCreditsForFailedGeneration } from '../src/credits/return.ts'
import { videoConsumeOperationKey, videoReturnOperationKey } from '../src/credits/contract.ts'
import { applyRefundCreated } from '../../../server/api/webhooks/creem.post.ts'
import { openExistingLedgerDatabase } from './ledger-harness.ts'

interface ConsumeJob {
  readonly kind: 'consume'
  readonly path: string
  readonly userId: string
  readonly generationId: string
  readonly creditAmount: number
  readonly nowMs: number
  readonly barrier: SharedArrayBuffer
}

interface ReturnJob {
  readonly kind: 'return'
  readonly path: string
  readonly userId: string
  readonly generationId: string
  readonly nowMs: number
  readonly expectedVersion: number
  readonly event: string
  readonly leaseOwner: string
  readonly leaseToken: string
  readonly errorCode: string
  readonly attemptId?: string
  readonly evidenceId?: string
  readonly providerRequestId?: string
  readonly barrier: SharedArrayBuffer
}

interface RefundJob {
  readonly kind: 'refund'
  readonly path: string
  readonly providerOrderId: string
  readonly providerRefundId: string
  readonly refundAmount: number
  readonly providerPaidAmount: number
  readonly providerEventId: string
  readonly barrier: SharedArrayBuffer
}

type Job = ConsumeJob | ReturnJob | RefundJob

const job = workerData as Job
const handle = openExistingLedgerDatabase(job.path)

function waitBarrier(buffer: SharedArrayBuffer, parties: number): void {
  const view = new Int32Array(buffer)
  const ticket = Atomics.add(view, 0, 1)
  if (ticket + 1 === parties) {
    Atomics.notify(view, 0)
    return
  }
  while (Atomics.load(view, 0) < parties) {
    const current = Atomics.load(view, 0)
    if (current >= parties) break
    Atomics.wait(view, 0, current)
  }
}

async function run(): Promise<unknown> {
  waitBarrier(job.barrier, 2)
  if (job.kind === 'consume') {
    return consumeCreditsForGeneration(handle.database, {
      userId: job.userId,
      generationId: job.generationId,
      creditAmount: job.creditAmount,
      operationId: videoConsumeOperationKey(job.generationId),
      nowMs: job.nowMs,
    })
  }
  if (job.kind === 'return') {
    return returnCreditsForFailedGeneration(handle.database, {
      userId: job.userId,
      generationId: job.generationId,
      operationId: videoReturnOperationKey(job.generationId),
      event: job.event,
      expectedVersion: job.expectedVersion,
      leaseOwner: job.leaseOwner,
      leaseToken: job.leaseToken,
      errorCode: job.errorCode,
      nowMs: job.nowMs,
      ...(job.attemptId ? { attemptId: job.attemptId } : {}),
      ...(job.evidenceId ? { evidenceId: job.evidenceId } : {}),
      ...(job.providerRequestId ? { providerRequestId: job.providerRequestId } : {}),
    })
  }
  return applyRefundCreated(handle.database as Parameters<typeof applyRefundCreated>[0], {
    kind: 'refund.created',
    providerEventId: job.providerEventId,
    eventType: 'refund.created',
    payloadHash: 'b'.repeat(64),
    refund: {
      providerRefundId: job.providerRefundId,
      status: 'succeeded',
      refundAmount: job.refundAmount,
      currency: 'USD',
      providerTransactionId: 'txn_race',
      providerOrderId: job.providerOrderId,
      providerPaidAmount: job.providerPaidAmount,
      reasonCode: null,
    },
  })
}

run()
  .then((result) => {
    handle.close()
    parentPort?.postMessage({ ok: true, result })
  })
  .catch((error: unknown) => {
    handle.close()
    parentPort?.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  })
