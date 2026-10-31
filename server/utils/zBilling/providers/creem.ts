/**
 * Server-only Creem API client for Checkout Initiation.
 *
 * - Production uses `https://api.creem.io/v1/`; other environments use Test
 * - Never logs raw response bodies, headers, cookies, or API keys
 * - Create Checkout response normalization + one optional Retrieve fallback
 */

import type {
  CheckoutProviderDetails,
  CheckoutProviderFieldDifference,
  CheckoutProviderStage,
} from '../../../types/api'
import { AppError } from '../../errors'

const CREEM_PRODUCTION_API_BASE = 'https://api.creem.io/v1'
const CREEM_TEST_API_BASE = 'https://test-api.creem.io/v1'
const CREEM_ROOT_HOSTNAME = 'creem.io'

type ServerEvent = Parameters<typeof getRequestURL>[0]

interface CreemRuntimeContext {
  cloudflare?: {
    env?: {
      CREEM_API_KEY?: unknown
      APP_ENVIRONMENT?: unknown
    }
  }
}

export type CreemProviderOutcome
  = | {
    kind: 'validated'
    checkoutId: string
    checkoutUrl: string
    httpStatus: number
    traceId: string | null
  }
  | {
    kind: 'rejected'
    details: CheckoutProviderDetails
  }
  | {
    kind: 'unknown'
    details: CheckoutProviderDetails
  }

export interface CreemCreateCheckoutInput {
  productId: string
  requestId: string
  units: number
  customPrice: number
  currency: string
  customerEmail: string
  successUrl: string
}

export interface ValidatedCreemCheckout {
  id: string
  checkoutUrl: string
  productId: string
  requestId: string
  units: number
  customPrice: number
  orderCurrency: string | null
  orderAmountDue: number | null
}

function getCreemApiKey(event: ServerEvent): string {
  const context = event.context as typeof event.context & CreemRuntimeContext
  const apiKey = context.cloudflare?.env?.CREEM_API_KEY

  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new AppError('SERVICE_UNAVAILABLE')
  }

  return apiKey
}

function getCreemApiBase(event: ServerEvent): string {
  const context = event.context as typeof event.context & CreemRuntimeContext
  return context.cloudflare?.env?.APP_ENVIRONMENT === 'production'
    ? CREEM_PRODUCTION_API_BASE
    : CREEM_TEST_API_BASE
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNonBlankString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return null
}

function normalizeProductId(payload: Record<string, unknown>): string | null {
  const direct = asNonBlankString(payload.product_id)
  if (direct) {
    return direct
  }

  const product = payload.product
  if (typeof product === 'string') {
    return asNonBlankString(product)
  }
  if (isRecord(product)) {
    return asNonBlankString(product.id)
  }

  return null
}

function extractOrderFacts(payload: Record<string, unknown>): {
  currency: string | null
  amountDue: number | null
} {
  const order = isRecord(payload.order) ? payload.order : null
  if (!order) {
    return { currency: null, amountDue: null }
  }

  return {
    currency: asNonBlankString(order.currency)?.toUpperCase() ?? null,
    amountDue: asFiniteNumber(order.amount_due),
  }
}

/**
 * Extract documented Checkout fields from compact or detailed responses.
 * Missing fields stay null — never invent financial facts.
 */
export function extractCheckoutFacts(
  payload: unknown,
): {
  id: string | null
  checkoutUrl: string | null
  productId: string | null
  requestId: string | null
  units: number | null
  customPrice: number | null
  orderCurrency: string | null
  orderAmountDue: number | null
} {
  if (!isRecord(payload)) {
    return {
      id: null,
      checkoutUrl: null,
      productId: null,
      requestId: null,
      units: null,
      customPrice: null,
      orderCurrency: null,
      orderAmountDue: null,
    }
  }

  const { currency, amountDue } = extractOrderFacts(payload)

  return {
    id: asNonBlankString(payload.id),
    checkoutUrl: asNonBlankString(payload.checkout_url),
    productId: normalizeProductId(payload),
    requestId: asNonBlankString(payload.request_id),
    units: asFiniteNumber(payload.units),
    customPrice: asFiniteNumber(payload.custom_price),
    orderCurrency: currency,
    orderAmountDue: amountDue,
  }
}

export function isTrustedCreemCheckoutUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const isCreemHostname = url.hostname === CREEM_ROOT_HOSTNAME
      || url.hostname.endsWith(`.${CREEM_ROOT_HOSTNAME}`)

    return (
      url.protocol === 'https:'
      && isCreemHostname
      && !url.username
      && !url.password
      && !url.port
    )
  }
  catch {
    return false
  }
}

function getCheckoutFieldDifferences(
  facts: ReturnType<typeof extractCheckoutFacts>,
  expected: {
    productId: string
    requestId: string
    units: number
    customPrice: number
    currency: string
    amountDue: number
  },
): CheckoutProviderFieldDifference[] {
  const differences: CheckoutProviderFieldDifference[] = []

  if (!facts.id) {
    differences.push({
      field: 'id',
      expected: 'non-empty string',
      actual: facts.id,
    })
  }
  if (!facts.checkoutUrl || !isTrustedCreemCheckoutUrl(facts.checkoutUrl)) {
    differences.push({
      field: 'checkout_url',
      expected: 'trusted HTTPS creem.io URL',
      actual: facts.checkoutUrl,
    })
  }

  const expectedFields: Array<{
    field: string
    expected: string | number
    actual: string | number | null
  }> = [
    { field: 'product_id', expected: expected.productId, actual: facts.productId },
    { field: 'request_id', expected: expected.requestId, actual: facts.requestId },
    { field: 'units', expected: expected.units, actual: facts.units },
    { field: 'custom_price', expected: expected.customPrice, actual: facts.customPrice },
  ]

  for (const field of expectedFields) {
    if (field.actual !== field.expected) {
      differences.push(field)
    }
  }

  if (
    facts.orderCurrency !== null
    && facts.orderCurrency !== expected.currency
  ) {
    differences.push({
      field: 'order.currency',
      expected: expected.currency,
      actual: facts.orderCurrency,
    })
  }
  if (
    facts.orderAmountDue !== null
    && facts.orderAmountDue !== expected.amountDue
  ) {
    differences.push({
      field: 'order.amount_due',
      expected: expected.amountDue,
      actual: facts.orderAmountDue,
    })
  }

  return differences
}

/**
 * Validate every mandatory Checkout invariant before URL exposure.
 */
export function validateCheckoutContract(
  facts: ReturnType<typeof extractCheckoutFacts>,
  expected: {
    productId: string
    requestId: string
    units: number
    customPrice: number
    currency: string
    amountDue: number
  },
): ValidatedCreemCheckout | null {
  if (
    !facts.id
    || !facts.checkoutUrl
    || !isTrustedCreemCheckoutUrl(facts.checkoutUrl)
    || !facts.productId
    || !facts.requestId
    || facts.units === null
    || facts.customPrice === null
  ) {
    return null
  }

  if (
    facts.productId !== expected.productId
    || facts.requestId !== expected.requestId
    || facts.units !== expected.units
    || facts.customPrice !== expected.customPrice
    || (
      facts.orderCurrency !== null
      && facts.orderCurrency !== expected.currency
    )
    || (
      facts.orderAmountDue !== null
      && facts.orderAmountDue !== expected.amountDue
    )
  ) {
    return null
  }

  return {
    id: facts.id,
    checkoutUrl: facts.checkoutUrl,
    productId: facts.productId,
    requestId: facts.requestId,
    units: facts.units,
    customPrice: facts.customPrice,
    orderCurrency: facts.orderCurrency,
    orderAmountDue: facts.orderAmountDue,
  }
}

function mergeCreateAndRetrieveFacts(
  createFacts: ReturnType<typeof extractCheckoutFacts>,
  retrieveFacts: ReturnType<typeof extractCheckoutFacts>,
): ReturnType<typeof extractCheckoutFacts> | null {
  if (!createFacts.id || !retrieveFacts.id || createFacts.id !== retrieveFacts.id) {
    return null
  }

  const overlapping: Array<keyof ReturnType<typeof extractCheckoutFacts>> = [
    'checkoutUrl',
    'productId',
    'requestId',
    'units',
    'customPrice',
    'orderCurrency',
    'orderAmountDue',
  ]

  for (const key of overlapping) {
    const createValue = createFacts[key]
    const retrieveValue = retrieveFacts[key]
    if (
      createValue !== null
      && retrieveValue !== null
      && createValue !== retrieveValue
    ) {
      return null
    }
  }

  return {
    id: createFacts.id,
    checkoutUrl: createFacts.checkoutUrl ?? retrieveFacts.checkoutUrl,
    productId: createFacts.productId ?? retrieveFacts.productId,
    requestId: createFacts.requestId ?? retrieveFacts.requestId,
    units: createFacts.units ?? retrieveFacts.units,
    customPrice: createFacts.customPrice ?? retrieveFacts.customPrice,
    orderCurrency: createFacts.orderCurrency ?? retrieveFacts.orderCurrency,
    orderAmountDue: createFacts.orderAmountDue ?? retrieveFacts.orderAmountDue,
  }
}

function isCompleteCheckoutFacts(
  facts: ReturnType<typeof extractCheckoutFacts>,
): boolean {
  return (
    facts.id !== null
    && facts.checkoutUrl !== null
    && facts.productId !== null
    && facts.requestId !== null
    && facts.units !== null
    && facts.customPrice !== null
  )
}

function getFetchStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') {
    return null
  }
  const candidate = error as {
    statusCode?: unknown
    status?: unknown
    response?: { status?: unknown }
  }
  if (typeof candidate.statusCode === 'number') {
    return candidate.statusCode
  }
  if (typeof candidate.status === 'number') {
    return candidate.status
  }
  if (typeof candidate.response?.status === 'number') {
    return candidate.response.status
  }
  return null
}

function getFetchErrorPayload(error: unknown): unknown {
  if (!isRecord(error)) {
    return null
  }
  if ('data' in error && error.data !== undefined) {
    return error.data
  }
  if (isRecord(error.response) && '_data' in error.response) {
    return error.response._data
  }
  return null
}

function extractCreemTraceId(payload: unknown): string | null {
  return isRecord(payload) ? asNonBlankString(payload.trace_id) : null
}

function extractCreemMessages(payload: unknown): string[] {
  if (!isRecord(payload)) {
    return []
  }

  if (typeof payload.message === 'string') {
    const message = asNonBlankString(payload.message)
    return message ? [message] : []
  }

  if (Array.isArray(payload.message)) {
    return payload.message.flatMap((value) => {
      const message = asNonBlankString(value)
      return message ? [message] : []
    })
  }

  return []
}

function createHttpErrorDetails(
  stage: CheckoutProviderStage,
  error: unknown,
): CheckoutProviderDetails {
  const payload = getFetchErrorPayload(error)
  const providerMessages = extractCreemMessages(payload)

  return {
    provider: 'creem',
    stage,
    httpStatus: getFetchStatus(error),
    traceId: extractCreemTraceId(payload),
    messages: providerMessages.length > 0
      ? providerMessages
      : error instanceof Error
        ? [error.message]
        : [],
    fieldDifferences: [],
  }
}

function createValidationDetails(input: {
  stage: 'create_validation' | 'retrieve_validation'
  httpStatus: number
  payload: unknown
  fallbackMessage: string
  fieldDifferences: CheckoutProviderFieldDifference[]
}): CheckoutProviderDetails {
  const providerMessages = extractCreemMessages(input.payload)

  return {
    provider: 'creem',
    stage: input.stage,
    httpStatus: input.httpStatus,
    traceId: extractCreemTraceId(input.payload),
    messages: providerMessages.length > 0
      ? providerMessages
      : [input.fallbackMessage],
    fieldDifferences: input.fieldDifferences,
  }
}

function classifyHttpStatus(status: number): 'rejected' | 'unknown' {
  if (status === 400 || status === 403 || status === 404) {
    return 'rejected'
  }
  return 'unknown'
}

/**
 * Validate Creem Product before local order insertion.
 * Requires an active, one-time, tax-inclusive Product in the expected currency.
 */
export async function validateCreemProduct(
  event: ServerEvent,
  providerProductId: string,
  expectedCurrency: string,
): Promise<'ok' | 'unknown'> {
  const apiKey = getCreemApiKey(event)
  const apiBase = getCreemApiBase(event)
  const normalizedExpectedCurrency = expectedCurrency.trim().toUpperCase()
  if (!normalizedExpectedCurrency) {
    return 'unknown'
  }

  try {
    const payload = await $fetch<unknown>(
      `${apiBase}/products`,
      {
        method: 'GET',
        query: {
          product_id: providerProductId,
        },
        headers: {
          'x-api-key': apiKey,
        },
      },
    )

    if (!isRecord(payload)) {
      return 'unknown'
    }

    const id = asNonBlankString(payload.id)
    const status = asNonBlankString(payload.status)?.toLowerCase()
    const billingType = asNonBlankString(payload.billing_type)?.toLowerCase()
    const currency = asNonBlankString(payload.currency)?.toUpperCase()
    const taxMode = asNonBlankString(payload.tax_mode)?.toLowerCase()
    // Creem may expose tax as tax_mode or tax.inclusive-style fields.
    const taxInclusive
      = taxMode === 'inclusive'
        || taxMode === 'tax_inclusive'
        || taxMode === 'included'
        || payload.tax_inclusive === true
        || (isRecord(payload.tax) && payload.tax.inclusive === true)

    if (
      id !== providerProductId
      || status !== 'active'
      || (billingType !== 'onetime' && billingType !== 'one_time' && billingType !== 'one-time')
      || currency !== normalizedExpectedCurrency
      || !taxInclusive
    ) {
      return 'unknown'
    }

    return 'ok'
  }
  catch {
    // Timeout, 4xx/5xx, network, non-JSON — all fail closed, no order insert.
    return 'unknown'
  }
}

async function retrieveCheckout(
  event: ServerEvent,
  checkoutId: string,
): Promise<
  | {
    kind: 'response'
    httpStatus: number
    payload: unknown
  }
  | {
    kind: 'error'
    details: CheckoutProviderDetails
  }
> {
  const apiKey = getCreemApiKey(event)
  const apiBase = getCreemApiBase(event)

  try {
    const response = await $fetch.raw<unknown>(
      `${apiBase}/checkouts`,
      {
        method: 'GET',
        query: {
          checkout_id: checkoutId,
        },
        headers: {
          'x-api-key': apiKey,
        },
      },
    )
    return {
      kind: 'response',
      httpStatus: response.status,
      payload: response._data,
    }
  }
  catch (error) {
    return {
      kind: 'error',
      details: createHttpErrorDetails('retrieve', error),
    }
  }
}

/**
 * Create Creem Test Checkout, normalize compact/detailed Create responses,
 * and optionally perform one non-mutating Retrieve when Create is incomplete.
 *
 * Never retries automatically. Never polls Retrieve.
 */
export async function createValidatedCreemCheckout(
  event: ServerEvent,
  input: CreemCreateCheckoutInput,
): Promise<CreemProviderOutcome> {
  const apiKey = getCreemApiKey(event)
  const apiBase = getCreemApiBase(event)

  let createHttpStatus: number
  let createPayload: unknown
  try {
    const response = await $fetch.raw<unknown>(
      `${apiBase}/checkouts`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: {
          product_id: input.productId,
          request_id: input.requestId,
          units: input.units,
          custom_price: input.customPrice,
          customer: {
            email: input.customerEmail,
          },
          success_url: input.successUrl,
        },
      },
    )
    createHttpStatus = response.status
    createPayload = response._data
  }
  catch (error) {
    const details = createHttpErrorDetails('create', error)
    if (
      details.httpStatus !== null
      && classifyHttpStatus(details.httpStatus) === 'rejected'
    ) {
      return { kind: 'rejected', details }
    }
    return { kind: 'unknown', details }
  }

  const createFacts = extractCheckoutFacts(createPayload)
  const expected = {
    productId: input.productId,
    requestId: input.requestId,
    units: input.units,
    customPrice: input.customPrice,
    currency: input.currency,
    amountDue: input.customPrice,
  }

  if (isCompleteCheckoutFacts(createFacts)) {
    const validated = validateCheckoutContract(createFacts, expected)
    if (!validated) {
      return {
        kind: 'unknown',
        details: createValidationDetails({
          stage: 'create_validation',
          httpStatus: createHttpStatus,
          payload: createPayload,
          fallbackMessage: 'Creem Checkout response did not match the requested checkout.',
          fieldDifferences: getCheckoutFieldDifferences(createFacts, expected),
        }),
      }
    }
    return {
      kind: 'validated',
      checkoutId: validated.id,
      checkoutUrl: validated.checkoutUrl,
      httpStatus: createHttpStatus,
      traceId: extractCreemTraceId(createPayload),
    }
  }

  // Incomplete Create: require a valid Checkout ID for one Retrieve fallback.
  if (!createFacts.id) {
    return {
      kind: 'unknown',
      details: createValidationDetails({
        stage: 'create_validation',
        httpStatus: createHttpStatus,
        payload: createPayload,
        fallbackMessage: 'Creem Checkout response did not contain a Checkout ID.',
        fieldDifferences: getCheckoutFieldDifferences(createFacts, expected),
      }),
    }
  }

  const retrieveResult = await retrieveCheckout(event, createFacts.id)
  if (retrieveResult.kind === 'error') {
    return {
      kind: 'unknown',
      details: {
        ...retrieveResult.details,
        fieldDifferences: getCheckoutFieldDifferences(createFacts, expected),
      },
    }
  }

  const retrievePayload = retrieveResult.payload
  const retrieveFacts = extractCheckoutFacts(retrievePayload)
  const merged = mergeCreateAndRetrieveFacts(createFacts, retrieveFacts)
  if (!merged) {
    const conflictingFields: CheckoutProviderFieldDifference[] = []
    const fields: Array<{
      key: keyof ReturnType<typeof extractCheckoutFacts>
      field: string
    }> = [
      { key: 'id', field: 'id' },
      { key: 'checkoutUrl', field: 'checkout_url' },
      { key: 'productId', field: 'product_id' },
      { key: 'requestId', field: 'request_id' },
      { key: 'units', field: 'units' },
      { key: 'customPrice', field: 'custom_price' },
      { key: 'orderCurrency', field: 'order.currency' },
      { key: 'orderAmountDue', field: 'order.amount_due' },
    ]

    for (const field of fields) {
      const createValue = createFacts[field.key]
      const retrieveValue = retrieveFacts[field.key]
      if (createValue !== retrieveValue) {
        conflictingFields.push({
          field: field.field,
          expected: createValue,
          actual: retrieveValue,
        })
      }
    }

    return {
      kind: 'unknown',
      details: createValidationDetails({
        stage: 'retrieve_validation',
        httpStatus: retrieveResult.httpStatus,
        payload: retrievePayload,
        fallbackMessage: 'Creem Create and Retrieve responses contained conflicting fields.',
        fieldDifferences: conflictingFields,
      }),
    }
  }

  const validated = validateCheckoutContract(merged, expected)
  if (!validated) {
    return {
      kind: 'unknown',
      details: createValidationDetails({
        stage: 'retrieve_validation',
        httpStatus: retrieveResult.httpStatus,
        payload: retrievePayload,
        fallbackMessage: 'Creem Checkout response did not match the requested checkout.',
        fieldDifferences: getCheckoutFieldDifferences(merged, expected),
      }),
    }
  }

  return {
    kind: 'validated',
    checkoutId: validated.id,
    checkoutUrl: validated.checkoutUrl,
    httpStatus: retrieveResult.httpStatus,
    traceId: extractCreemTraceId(retrievePayload)
      ?? extractCreemTraceId(createPayload),
  }
}
