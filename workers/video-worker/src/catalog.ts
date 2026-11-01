import { createLocalMockRegistries } from '../../../packages/video-core/src/development-catalog.ts'
import { MOCK_FIXTURE_ID } from '../../../packages/data/src/video/protocol.ts'

/** Development and test only. Production does not construct a provider. */
export function localMockRegistries(environment: string, clock: { nowMs(): number }) {
  return createLocalMockRegistries(environment, clock, MOCK_FIXTURE_ID)
}
