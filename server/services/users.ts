import { clerkClient } from '@clerk/nuxt/server'
import { runDatabaseOperation } from '../database/client'
import { users } from '../database/schema'
import { AppError } from '../utils/errors'
import {
  lastLoginAtInsertValue,
  mapClerkUserToProfile,
  mergeLocalUserConflictUpdate,
  type EnsureLocalUserOptions,
  type LocalUser,
} from './user-profile'

export type { EnsureLocalUserOptions, LocalUser, NormalizedClerkProfile } from './user-profile'
export {
  LOCAL_USER_CONFLICT_UPDATE_KEYS,
  LOCAL_USER_IMMUTABLE_KEYS,
  buildLocalUserConflictUpdate,
  clerkMsToDate,
  lastLoginAtInsertValue,
  mapClerkUserToProfile,
  mergeLocalUserConflictUpdate,
  normalizeBlankString,
  resolveDisplayName,
  selectPrimaryEmail,
  toPublicUserDto,
} from './user-profile'

type ServerEvent = Parameters<typeof getRequestURL>[0]
type ClerkBackendClient = ReturnType<typeof clerkClient>

/**
 * `@clerk/nuxt` types `clerkClient` against a nested h3 copy under pnpm, while
 * Nitro/app code uses the project-level h3. The runtime event is the same object;
 * only the duplicate H3Event type identity differs.
 */
function getClerkBackendClient(event: ServerEvent): ClerkBackendClient {
  return (clerkClient as (event: ServerEvent) => ClerkBackendClient)(event)
}

function getSessionAuth(event: ServerEvent) {
  const authFn = event.context.auth

  if (typeof authFn !== 'function') {
    throw new AppError('UNAUTHORIZED')
  }

  // Restrict to Clerk session tokens only for /api/me identity.
  return authFn({ acceptsToken: 'session_token' })
}

export async function ensureLocalUser(
  event: ServerEvent,
  options?: EnsureLocalUserOptions,
): Promise<LocalUser> {
  const auth = getSessionAuth(event)

  if (!auth.isAuthenticated) {
    throw new AppError('UNAUTHORIZED')
  }

  if (!auth.userId) {
    // Authenticated state without a user id is unexpected; do not write D1.
    console.error('[users] Authenticated Clerk session missing userId')
    throw new AppError('INTERNAL_ERROR')
  }

  // Avoid importing `@clerk/backend` directly (transitive under pnpm; vue-tsc cannot resolve it).
  // Let getUser's return type flow into mapClerkUserToProfile(ClerkUserLike).
  let clerkUser: Parameters<typeof mapClerkUserToProfile>[0]

  try {
    clerkUser = await getClerkBackendClient(event).users.getUser(auth.userId)
  }
  catch {
    // Do not attach raw Clerk errors as cause — messages may include request details.
    console.error('[users] Clerk backend user fetch failed')
    throw new AppError('SERVICE_UNAVAILABLE')
  }

  const profile = mapClerkUserToProfile(clerkUser)
  const now = new Date()
  const conflictUpdate = mergeLocalUserConflictUpdate(profile, now, options)

  const [localUser] = await runDatabaseOperation(event, database =>
    database
      .insert(users)
      .values({
        id: crypto.randomUUID(),
        clerkUserId: profile.clerkUserId,
        primaryEmail: profile.primaryEmail,
        emailVerified: profile.emailVerified,
        firstName: profile.firstName,
        lastName: profile.lastName,
        displayName: profile.displayName,
        username: profile.username,
        avatarUrl: profile.avatarUrl,
        clerkCreatedAt: profile.clerkCreatedAt,
        clerkUpdatedAt: profile.clerkUpdatedAt,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
        lastLoginAt: lastLoginAtInsertValue(now, options),
      })
      .onConflictDoUpdate({
        target: users.clerkUserId,
        set: conflictUpdate,
      })
      .returning(),
  )

  if (!localUser) {
    throw new AppError('INTERNAL_ERROR')
  }

  return localUser
}
