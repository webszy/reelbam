// Named webhook functions can be exercised under Node without starting Nitro.
// Import before creem.post.ts in both the test process and worker threads.
const scope = globalThis as typeof globalThis & { defineEventHandler?: (handler: unknown) => unknown }
scope.defineEventHandler ??= handler => handler
