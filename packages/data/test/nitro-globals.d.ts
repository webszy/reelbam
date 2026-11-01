/** Type-only declarations for the Nitro boundary imported by database tests.
 * These use the same H3 API types as Nitro, without loading .nuxt or the app. */
export {}
declare global {
  const getRequestURL: typeof import('h3').getRequestURL
  const defineEventHandler: typeof import('h3').defineEventHandler
  const setResponseHeader: typeof import('h3').setResponseHeader
  const setResponseStatus: typeof import('h3').setResponseStatus
  const readRawBody: typeof import('h3').readRawBody
  const getHeader: typeof import('h3').getHeader
}
