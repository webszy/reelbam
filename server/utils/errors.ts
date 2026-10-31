import type { ApiResponse, AuthorizationErrorCode, CheckoutErrorCode, CheckoutErrorDebug, CheckoutErrorResponse, CheckoutProviderDetails, EnvelopeErrorCode, InfrastructureErrorCode } from '../types/api'
type ServerEvent = Parameters<typeof getRequestURL>[0]
interface CloudflareEnvironmentContext { cloudflare?: { env?: { APP_ENVIRONMENT?: unknown } } }
const ENVELOPE_ERROR_STATUS: Record<EnvelopeErrorCode, number> = {
  UNAUTHORIZED: 401,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
}

const CHECKOUT_ERROR_STATUS: Record<CheckoutErrorCode, number> = {
  INVALID_IDEMPOTENCY_KEY: 400,
  CHECKOUT_EMAIL_REQUIRED: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  CHECKOUT_IN_PROGRESS: 409,
  CHECKOUT_FAILED: 409,
  CHECKOUT_CREATION_UNKNOWN: 503,
  UNAUTHORIZED: 401,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
}

export class AppError extends Error {
  readonly code: InfrastructureErrorCode | AuthorizationErrorCode

  constructor(
    code: InfrastructureErrorCode | AuthorizationErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options)
    this.name = 'AppError'
    this.code = code
  }
}

export class CheckoutError extends Error {
  readonly code: CheckoutErrorCode
  readonly details?: CheckoutProviderDetails

  constructor(
    code: CheckoutErrorCode,
    options?: ErrorOptions & { details?: CheckoutProviderDetails },
  ) {
    super(code, options)
    this.name = 'CheckoutError'
    this.code = code
    this.details = options?.details
  }
}

function isDevelopmentEnvironment(event: ServerEvent): boolean {
  const context = event.context as typeof event.context
    & CloudflareEnvironmentContext
  return context.cloudflare?.env?.APP_ENVIRONMENT === 'development'
}

function getErrorLogContext(error: unknown): CheckoutErrorDebug {
  const source = error instanceof AppError && error.cause !== undefined
    ? error.cause
    : error

  if (!(source instanceof Error)) {
    return {
      type: typeof source,
    }
  }

  return {
    name: source.name,
    message: source.message.replace(
      /\nparams:[\s\S]*/i,
      '\nparams: [redacted]',
    ),
    stack: source.stack
      ?.split('\n')
      .filter(line => /^\s+at\s/.test(line))
      .join('\n'),
  }
}

export function sendApiEnvelopeError<TCode extends EnvelopeErrorCode>(
  event: ServerEvent,
  code: TCode,
): ApiResponse<never, TCode> {
  setResponseStatus(event, ENVELOPE_ERROR_STATUS[code])

  return {
    success: false,
    data: null,
    code,
  }
}

export function handleApiEnvelopeError(
  event: ServerEvent,
  error: unknown,
): ApiResponse<never, EnvelopeErrorCode> {
  if (error instanceof AppError && error.code === 'UNAUTHORIZED') {
    return sendApiEnvelopeError(event, 'UNAUTHORIZED')
  }

  const code = error instanceof AppError
    && (error.code === 'SERVICE_UNAVAILABLE' || error.code === 'INTERNAL_ERROR')
    ? error.code
    : 'INTERNAL_ERROR'

  console.error(
    `[api] Request failed with ${code}`,
    getErrorLogContext(error),
  )

  return sendApiEnvelopeError(event, code)
}

export function sendCheckoutError<TCode extends CheckoutErrorCode>(
  event: ServerEvent,
  code: TCode,
  details?: CheckoutProviderDetails,
  debug?: CheckoutErrorDebug,
): CheckoutErrorResponse<TCode> {
  setResponseStatus(event, CHECKOUT_ERROR_STATUS[code])
  const exposeDiagnostics = isDevelopmentEnvironment(event)

  return {
    success: false,
    data: null,
    code,
    ...(exposeDiagnostics && details ? { details } : {}),
    ...(exposeDiagnostics && debug ? { debug } : {}),
  }
}

export function handleCheckoutError(
  event: ServerEvent,
  error: unknown,
): CheckoutErrorResponse {
  if (error instanceof CheckoutError) {
    if (
      error.details
      || error.code === 'SERVICE_UNAVAILABLE'
      || error.code === 'INTERNAL_ERROR'
      || error.code === 'CHECKOUT_CREATION_UNKNOWN'
    ) {
      console.error(
        `[api/billing/checkout] ${error.code}`,
        {
          ...getErrorLogContext(error),
          ...(error.details ? { details: error.details } : {}),
        },
      )
    }

    return sendCheckoutError(event, error.code, error.details, getErrorLogContext(error))
  }

  if (error instanceof AppError && error.code === 'UNAUTHORIZED') {
    return sendCheckoutError(event, 'UNAUTHORIZED', undefined, getErrorLogContext(error))
  }

  const code = error instanceof AppError
    && (error.code === 'SERVICE_UNAVAILABLE' || error.code === 'INTERNAL_ERROR')
    ? error.code
    : 'INTERNAL_ERROR'

  const debug = getErrorLogContext(error)
  console.error(
    `[api/billing/checkout] ${code}`,
    debug,
  )

  return sendCheckoutError(event, code, undefined, debug)
}

