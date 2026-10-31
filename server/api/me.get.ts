import { runDatabaseOperation } from '../database/client'
import { getAvailableCredits } from '../../packages/data/src/credits/spendable.ts'
import { ensureLocalUser } from '../services/users'
import { toPublicUserDto } from '../services/user-profile'
import { handleApiEnvelopeError } from '../utils/errors'
import type { MeResponse } from '../types/api'
export default defineEventHandler(async (event): Promise<MeResponse> => {
  setResponseHeader(event, 'cache-control', 'no-store')
  try {
    const user = await ensureLocalUser(event, { recordLoginAt: true })
    const now = new Date()
    const credits = await runDatabaseOperation(event, db => getAvailableCredits(db, user.id, now))
    return { success: true, data: { ...toPublicUserDto(user), credits } }
  } catch (error) { return handleApiEnvelopeError(event, error) }
})
