import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema/index.ts'

/**
 * D1 client for callers that already hold a binding.
 * Nuxt event access stays in server/database/client.ts.
 */
export function createDatabase(binding: Parameters<typeof drizzle>[0]) {
  return drizzle(binding, { schema })
}

export type Database = ReturnType<typeof createDatabase>
