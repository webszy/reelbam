import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildLocalUserConflictUpdate, mapClerkUserToProfile, toPublicUserDto, type LocalUser } from './user-profile.ts'
test('Clerk profile sync preserves identity and never reintroduces business entitlements', () => {
  const profile = mapClerkUserToProfile({ id: 'clerk_test', firstName: ' Ada ', lastName: ' Lovelace ', username: null, imageUrl: null, fullName: null, emailAddresses: [{ emailAddress: 'ada@example.com', verification: { status: 'verified' } }], createdAt: 1700000000000, updatedAt: 1700000001000 })
  assert.equal(profile.displayName, 'Ada Lovelace')
  assert.equal(profile.emailVerified, true)
  const update = buildLocalUserConflictUpdate(profile, new Date())
  for (const key of ['id', 'clerkUserId', 'createdAt', 'clerkCreatedAt', 'credits']) assert.equal(key in update, false)
})
test('public profile excludes Clerk identity and serializes dates', () => {
  const now = new Date('2026-09-20T00:00:00Z')
  const user: LocalUser = { id: 'local_test', clerkUserId: 'clerk_test', primaryEmail: 'ada@example.com', emailVerified: true, firstName: 'Ada', lastName: null, displayName: 'Ada', username: null, avatarUrl: null, clerkCreatedAt: now, clerkUpdatedAt: now, createdAt: now, updatedAt: now, lastSeenAt: now, lastLoginAt: null }
  const dto = toPublicUserDto(user)
  assert.equal(dto.email, 'ada@example.com')
  assert.equal(dto.createdAt, now.toISOString())
  assert.equal(dto.lastLoginAt, null)
  assert.equal('clerkUserId' in dto, false)
  assert.deepEqual(Object.keys(dto).sort(), ['id','email','emailVerified','firstName','lastName','displayName','username','avatarUrl','createdAt','lastSeenAt','lastLoginAt'].sort())
})
