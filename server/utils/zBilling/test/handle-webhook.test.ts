import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  computeCreemWebhookSignature,
  verifyAndNormalizeCreemWebhook,
} from '../application/handle-webhook.ts'

const SECRET = 'whsec_test_secret_value'

function sampleCheckoutCompleted(overrides?: {
  eventId?: string
  checkoutId?: string
  orderId?: string
  orderStatus?: string
  amount?: number
  currency?: string
  requestId?: string | null
}): string {
  const body = {
    id: overrides?.eventId ?? 'evt_test_1',
    eventType: 'checkout.completed',
    created_at: 1728734325927,
    object: {
      id: overrides?.checkoutId ?? 'ch_test_1',
      object: 'checkout',
      request_id: overrides?.requestId === null
        ? undefined
        : (overrides?.requestId ?? 'order-local-1'),
      order: {
        id: overrides?.orderId ?? 'ord_test_1',
        amount: overrides?.amount ?? 499,
        currency: overrides?.currency ?? 'USD',
        status: overrides?.orderStatus ?? 'paid',
        type: 'onetime',
      },
      status: 'completed',
    },
  }
  return JSON.stringify(body)
}

describe('verifyAndNormalizeCreemWebhook', () => {
  it('accepts a correctly signed checkout.completed payload', async () => {
    const rawBody = sampleCheckoutCompleted()
    const signature = await computeCreemWebhookSignature(rawBody, SECRET)

    const result = await verifyAndNormalizeCreemWebhook({
      rawBody,
      signatureHeader: signature,
      webhookSecret: SECRET,
    })

    assert.equal(result.ok, true)
    if (!result.ok) {
      return
    }
    assert.equal(result.event.kind, 'checkout.completed')
    if (result.event.kind !== 'checkout.completed') {
      return
    }
    assert.equal(result.event.providerEventId, 'evt_test_1')
    assert.equal(result.event.checkout.checkoutId, 'ch_test_1')
    assert.equal(result.event.checkout.providerOrderId, 'ord_test_1')
    assert.equal(result.event.checkout.orderStatus, 'paid')
    assert.equal(result.event.checkout.amount, 499)
    assert.equal(result.event.checkout.currency, 'USD')
    assert.equal(result.event.checkout.requestId, 'order-local-1')
    assert.ok(result.event.payloadHash.length === 64)
  })

  it('rejects missing or invalid signatures before trusting the payload', async () => {
    const rawBody = sampleCheckoutCompleted()

    const missing = await verifyAndNormalizeCreemWebhook({
      rawBody,
      signatureHeader: undefined,
      webhookSecret: SECRET,
    })
    assert.deepEqual(missing, { ok: false, reason: 'invalid_signature' })

    const wrong = await verifyAndNormalizeCreemWebhook({
      rawBody,
      signatureHeader: 'a'.repeat(64),
      webhookSecret: SECRET,
    })
    assert.deepEqual(wrong, { ok: false, reason: 'invalid_signature' })

    const wrongSecret = await verifyAndNormalizeCreemWebhook({
      rawBody,
      signatureHeader: await computeCreemWebhookSignature(rawBody, SECRET),
      webhookSecret: 'other-secret',
    })
    assert.deepEqual(wrongSecret, { ok: false, reason: 'invalid_signature' })
  })

  it('rejects incomplete checkout.completed events', async () => {
    const rawBody = JSON.stringify({
      id: 'evt_bad',
      eventType: 'checkout.completed',
      object: {
        id: 'ch_1',
        // missing paid order
      },
    })
    const signature = await computeCreemWebhookSignature(rawBody, SECRET)

    const result = await verifyAndNormalizeCreemWebhook({
      rawBody,
      signatureHeader: signature,
      webhookSecret: SECRET,
    })
    assert.deepEqual(result, {
      ok: false,
      reason: 'incomplete_completed_event',
    })
  })

  it('rejects checkout.completed when order status is not paid', async () => {
    const rawBody = sampleCheckoutCompleted({ orderStatus: 'pending' })
    const signature = await computeCreemWebhookSignature(rawBody, SECRET)

    const result = await verifyAndNormalizeCreemWebhook({
      rawBody,
      signatureHeader: signature,
      webhookSecret: SECRET,
    })
    assert.deepEqual(result, {
      ok: false,
      reason: 'incomplete_completed_event',
    })
  })

  it('normalizes non-completed event types as unsupported without paid facts', async () => {
    const rawBody = JSON.stringify({
      id: 'evt_sub_1',
      eventType: 'subscription.active',
      object: { id: 'sub_1' },
    })
    const signature = await computeCreemWebhookSignature(rawBody, SECRET)

    const result = await verifyAndNormalizeCreemWebhook({
      rawBody,
      signatureHeader: signature,
      webhookSecret: SECRET,
    })

    assert.equal(result.ok, true)
    if (!result.ok) {
      return
    }
    assert.equal(result.event.kind, 'unsupported')
    if (result.event.kind !== 'unsupported') {
      return
    }
    assert.equal(result.event.providerEventId, 'evt_sub_1')
    assert.equal(result.event.eventType, 'subscription.active')
  })

  it('rejects malformed JSON payloads after a valid signature', async () => {
    const rawBody = '{not-json'
    const signature = await computeCreemWebhookSignature(rawBody, SECRET)
    const result = await verifyAndNormalizeCreemWebhook({
      rawBody,
      signatureHeader: signature,
      webhookSecret: SECRET,
    })
    assert.deepEqual(result, { ok: false, reason: 'malformed_payload' })
  })

  it('normalizes Creem documented refund.created gross payment fields', async () => {
    const rawBody = JSON.stringify({
      id: 'evt_ref_1',
      eventType: 'refund.created',
      object: {
        id: 'ref_1',
        status: 'succeeded',
        refund_amount: 1210,
        refund_currency: 'EUR',
        transaction: {
          id: 'txn_1',
          amount: 1000,
          amount_paid: 1210,
          order: 'ord_1',
        },
      },
    })
    const signature = await computeCreemWebhookSignature(rawBody, SECRET)
    const result = await verifyAndNormalizeCreemWebhook({
      rawBody,
      signatureHeader: signature,
      webhookSecret: SECRET,
    })
    assert.equal(result.ok, true)
    if (!result.ok || result.event.kind !== 'refund.created') {
      assert.fail('expected refund.created')
      return
    }
    assert.equal(result.event.refund.providerRefundId, 'ref_1')
    assert.equal(result.event.refund.refundAmount, 1210)
    assert.equal(result.event.refund.currency, 'EUR')
    assert.equal(result.event.refund.providerOrderId, 'ord_1')
    assert.equal(result.event.refund.providerTransactionId, 'txn_1')
    assert.equal(result.event.refund.providerPaidAmount, 1210)
  })

  it('rejects incomplete refund.created without provider paid amount', async () => {
    const rawBody = JSON.stringify({
      id: 'evt_ref_bad',
      eventType: 'refund.created',
      object: {
        id: 'ref_2',
        status: 'succeeded',
        amount: 100,
        currency: 'USD',
        transaction: {
          id: 'txn_2',
          order: { id: 'ord_1' },
          // missing amount
        },
      },
    })
    const signature = await computeCreemWebhookSignature(rawBody, SECRET)
    const result = await verifyAndNormalizeCreemWebhook({
      rawBody,
      signatureHeader: signature,
      webhookSecret: SECRET,
    })
    assert.deepEqual(result, {
      ok: false,
      reason: 'incomplete_refund_event',
    })
  })

  it('normalizes a signed dispute.created event as opened audit facts', async () => {
    const rawBody = JSON.stringify({
      id: 'evt_disp_1',
      eventType: 'dispute.created',
      object: {
        id: 'disp_1',
        amount: 499,
        currency: 'USD',
        order: { id: 'ord_1' },
        transaction: { id: 'txn_1' },
      },
    })
    const signature = await computeCreemWebhookSignature(rawBody, SECRET)
    const result = await verifyAndNormalizeCreemWebhook({
      rawBody,
      signatureHeader: signature,
      webhookSecret: SECRET,
    })
    assert.equal(result.ok, true)
    if (!result.ok || result.event.kind !== 'dispute.created') {
      assert.fail('expected dispute.created')
      return
    }
    assert.equal(result.event.dispute.providerDisputeId, 'disp_1')
    assert.equal(result.event.dispute.providerOrderId, 'ord_1')
    assert.equal(result.event.dispute.providerTransactionId, 'txn_1')
    assert.equal(result.event.dispute.amount, 499)
    assert.equal(result.event.dispute.currency, 'USD')
  })
})
