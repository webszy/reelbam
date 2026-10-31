import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  extractCheckoutFacts,
  isTrustedCreemCheckoutUrl,
  validateCheckoutContract,
} from '../providers/creem.ts'

describe('extractCheckoutFacts', () => {
  it('reads a detailed Create response', () => {
    const facts = extractCheckoutFacts({
      id: 'ch_1',
      checkout_url: 'https://checkout.creem.io/ch_1',
      product_id: 'prod_1',
      request_id: 'order_1',
      units: 1,
      custom_price: 499,
      order: {
        currency: 'USD',
        amount_due: 499,
      },
    })

    assert.deepEqual(facts, {
      id: 'ch_1',
      checkoutUrl: 'https://checkout.creem.io/ch_1',
      productId: 'prod_1',
      requestId: 'order_1',
      units: 1,
      customPrice: 499,
      orderCurrency: 'USD',
      orderAmountDue: 499,
    })
  })

  it('normalizes product object form and leaves missing financial fields null', () => {
    const facts = extractCheckoutFacts({
      id: 'ch_2',
      checkout_url: 'https://checkout.creem.io/ch_2',
      product: { id: 'prod_2' },
      request_id: 'order_2',
    })

    assert.equal(facts.productId, 'prod_2')
    assert.equal(facts.units, null)
    assert.equal(facts.customPrice, null)
    assert.equal(facts.orderCurrency, null)
    assert.equal(facts.orderAmountDue, null)
  })

  it('does not invent fields from malformed payloads', () => {
    assert.equal(extractCheckoutFacts(null).id, null)
    assert.equal(extractCheckoutFacts('x').id, null)
    assert.equal(extractCheckoutFacts({}).id, null)
  })
})

describe('validateCheckoutContract', () => {
  const expected = {
    productId: 'prod_1',
    requestId: 'order_1',
    units: 1,
    customPrice: 499,
    currency: 'USD',
    amountDue: 499,
  }

  it('accepts a complete matching contract with HTTPS URL', () => {
    const validated = validateCheckoutContract(
      {
        id: 'ch_1',
        checkoutUrl: 'https://checkout.creem.io/ch_1',
        productId: 'prod_1',
        requestId: 'order_1',
        units: 1,
        customPrice: 499,
        orderCurrency: 'USD',
        orderAmountDue: 499,
      },
      expected,
    )

    assert.ok(validated)
    assert.equal(validated?.checkoutUrl, 'https://checkout.creem.io/ch_1')
  })

  it('accepts a matching Checkout before Creem creates order fields', () => {
    const validated = validateCheckoutContract(
      {
        id: 'ch_1',
        checkoutUrl: 'https://checkout.creem.io/ch_1',
        productId: 'prod_1',
        requestId: 'order_1',
        units: 1,
        customPrice: 499,
        orderCurrency: null,
        orderAmountDue: null,
      },
      expected,
    )

    assert.ok(validated)
    assert.equal(validated?.orderCurrency, null)
    assert.equal(validated?.orderAmountDue, null)
  })

  it('rejects untrusted checkout URLs and amount mismatches', () => {
    assert.equal(
      validateCheckoutContract(
        {
          id: 'ch_1',
          checkoutUrl: 'http://checkout.creem.io/ch_1',
          productId: 'prod_1',
          requestId: 'order_1',
          units: 1,
          customPrice: 499,
          orderCurrency: 'USD',
          orderAmountDue: 499,
        },
        expected,
      ),
      null,
    )

    assert.equal(
      validateCheckoutContract(
        {
          id: 'ch_1',
          checkoutUrl: 'https://example.com/ch_1',
          productId: 'prod_1',
          requestId: 'order_1',
          units: 1,
          customPrice: 499,
          orderCurrency: 'USD',
          orderAmountDue: 499,
        },
        expected,
      ),
      null,
    )

    assert.equal(
      validateCheckoutContract(
        {
          id: 'ch_1',
          checkoutUrl: 'https://checkout.creem.io/ch_1',
          productId: 'prod_1',
          requestId: 'order_1',
          units: 1,
          customPrice: 499,
          orderCurrency: 'USD',
          orderAmountDue: 500,
        },
        expected,
      ),
      null,
    )
  })
})

describe('isTrustedCreemCheckoutUrl', () => {
  it('accepts HTTPS Creem root and subdomain URLs', () => {
    assert.equal(isTrustedCreemCheckoutUrl('https://creem.io/payment/ch_1'), true)
    assert.equal(isTrustedCreemCheckoutUrl('https://checkout.creem.io/ch_1'), true)
  })

  it('rejects non-Creem, deceptive, credentialed, and non-standard-port URLs', () => {
    const rejected = [
      'https://example.com/x',
      'https://checkout.creem.io.evil.example/x',
      'https://user:pass@checkout.creem.io/x',
      'https://checkout.creem.io:8443/x',
      'http://checkout.creem.io/x',
      'not-a-url',
    ]

    for (const value of rejected) {
      assert.equal(isTrustedCreemCheckoutUrl(value), false)
    }
  })
})
