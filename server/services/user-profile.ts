import type { users } from '../database/schema'
import type {
  PublicUserDto,
} from '../types/api'

export type LocalUser = typeof users.$inferSelect

/**
 * Trusted profile fields derived from Clerk Backend User.
 * Kept free of Clerk runtime imports so pure unit tests can load this module.
 */
export interface NormalizedClerkProfile {
  clerkUserId: string
  primaryEmail: string | null
  emailVerified: boolean
  firstName: string | null
  lastName: string | null
  displayName: string | null
  username: string | null
  avatarUrl: string | null
  clerkCreatedAt: Date | null
  clerkUpdatedAt: Date | null
}

export const LOCAL_USER_IMMUTABLE_KEYS = [
  'id',
  'clerkUserId',
  'createdAt',
  'clerkCreatedAt',
] as const satisfies ReadonlyArray<keyof LocalUser>

/**
 * Single source of truth for ON CONFLICT DO UPDATE columns.
 * Immutable identity/creation columns
 * must never appear in this object.
 */
export function buildLocalUserConflictUpdate(
  profile: NormalizedClerkProfile,
  now: Date,
) {
  return {
    primaryEmail: profile.primaryEmail,
    emailVerified: profile.emailVerified,
    firstName: profile.firstName,
    lastName: profile.lastName,
    displayName: profile.displayName,
    username: profile.username,
    avatarUrl: profile.avatarUrl,
    clerkUpdatedAt: profile.clerkUpdatedAt,
    updatedAt: now,
    lastSeenAt: now,
  }
}

export type LocalUserConflictUpdate = ReturnType<typeof buildLocalUserConflictUpdate>

export interface EnsureLocalUserOptions {
  recordLoginAt?: boolean
}

export function lastLoginAtInsertValue(
  now: Date,
  options?: EnsureLocalUserOptions,
): Date | null {
  return options?.recordLoginAt ? now : null
}

export function mergeLocalUserConflictUpdate(
  profile: NormalizedClerkProfile,
  now: Date,
  options: EnsureLocalUserOptions & { recordLoginAt: true },
): LocalUserConflictUpdate & { lastLoginAt: Date }
export function mergeLocalUserConflictUpdate(
  profile: NormalizedClerkProfile,
  now: Date,
  options?: EnsureLocalUserOptions,
): LocalUserConflictUpdate
export function mergeLocalUserConflictUpdate(
  profile: NormalizedClerkProfile,
  now: Date,
  options?: EnsureLocalUserOptions,
): LocalUserConflictUpdate & { lastLoginAt?: Date } {
  const update = buildLocalUserConflictUpdate(profile, now)
  if (!options?.recordLoginAt) {
    return update
  }

  return {
    ...update,
    lastLoginAt: now,
  }
}

/**
 * Keys of the conflict update set. Derived from a sample build so the key list
 * cannot drift from `buildLocalUserConflictUpdate`.
 */
export const LOCAL_USER_CONFLICT_UPDATE_KEYS = Object.keys(
  buildLocalUserConflictUpdate(
    {
      clerkUserId: 'key-probe',
      primaryEmail: null,
      emailVerified: false,
      firstName: null,
      lastName: null,
      displayName: null,
      username: null,
      avatarUrl: null,
      clerkCreatedAt: null,
      clerkUpdatedAt: null,
    },
    new Date(0),
  ),
) as Array<keyof LocalUserConflictUpdate & keyof LocalUser>

/** Minimal Clerk-like email shape used by pure mapping helpers. */
export interface ClerkEmailLike {
  emailAddress?: string | null
  verification?: { status?: string | null } | null
}

/** Minimal Clerk Backend User shape used by pure mapping helpers. */
export interface ClerkUserLike {
  id: string
  firstName?: string | null
  lastName?: string | null
  username?: string | null
  imageUrl?: string | null
  fullName?: string | null
  createdAt?: number | null
  updatedAt?: number | null
  primaryEmailAddress?: ClerkEmailLike | null
  emailAddresses?: ClerkEmailLike[]
}

export function normalizeBlankString(value: string | null | undefined) {
  if (typeof value !== 'string') {
    return null
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function clerkMsToDate(timestamp: number | null | undefined) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return null
  }

  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? null : date
}

export function selectPrimaryEmail(user: {
  primaryEmailAddress?: ClerkEmailLike | null
  emailAddresses?: ClerkEmailLike[]
}) {
  const candidates: ClerkEmailLike[] = []

  if (user.primaryEmailAddress) {
    candidates.push(user.primaryEmailAddress)
  }

  if (Array.isArray(user.emailAddresses)) {
    for (const email of user.emailAddresses) {
      candidates.push(email)
    }
  }

  for (const candidate of candidates) {
    const primaryEmail = normalizeBlankString(candidate.emailAddress)

    if (primaryEmail) {
      return {
        primaryEmail,
        emailVerified: candidate.verification?.status === 'verified',
      }
    }
  }

  return {
    primaryEmail: null,
    emailVerified: false,
  }
}

export function resolveDisplayName(input: {
  fullName?: string | null
  firstName?: string | null
  lastName?: string | null
  username?: string | null
  primaryEmail?: string | null
}) {
  const fullName = normalizeBlankString(input.fullName)
  if (fullName) {
    return fullName
  }

  const firstName = normalizeBlankString(input.firstName)
  const lastName = normalizeBlankString(input.lastName)
  const joinedName = normalizeBlankString(
    [firstName, lastName].filter(Boolean).join(' '),
  )
  if (joinedName) {
    return joinedName
  }

  const username = normalizeBlankString(input.username)
  if (username) {
    return username
  }

  return normalizeBlankString(input.primaryEmail)
}

export function mapClerkUserToProfile(
  clerkUser: ClerkUserLike,
): NormalizedClerkProfile {
  const { primaryEmail, emailVerified } = selectPrimaryEmail(clerkUser)
  const firstName = normalizeBlankString(clerkUser.firstName)
  const lastName = normalizeBlankString(clerkUser.lastName)
  const username = normalizeBlankString(clerkUser.username)
  const avatarUrl = normalizeBlankString(clerkUser.imageUrl)

  return {
    clerkUserId: clerkUser.id,
    primaryEmail,
    emailVerified,
    firstName,
    lastName,
    displayName: resolveDisplayName({
      fullName: clerkUser.fullName,
      firstName,
      lastName,
      username,
      primaryEmail,
    }),
    username,
    avatarUrl,
    clerkCreatedAt: clerkMsToDate(clerkUser.createdAt),
    clerkUpdatedAt: clerkMsToDate(clerkUser.updatedAt),
  }
}

export function toPublicUserDto(user: LocalUser): PublicUserDto {
  return {
    id: user.id,
    email: user.primaryEmail,
    emailVerified: user.emailVerified,
    firstName: user.firstName,
    lastName: user.lastName,
    displayName: user.displayName,
    username: user.username,
    avatarUrl: user.avatarUrl,
    createdAt: user.createdAt.toISOString(),
    lastSeenAt: user.lastSeenAt.toISOString(),
    lastLoginAt: user.lastLoginAt
      ? user.lastLoginAt.toISOString()
      : null,
  }
}
