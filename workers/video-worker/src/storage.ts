import type { VideoObjectStore } from '../../../packages/data/src/video/protocol.ts'
import type { VideoObjectBinding } from './bindings.ts'

export function r2ObjectStore(bucket: VideoObjectBinding): VideoObjectStore {
  return {
    async put(key, body, contentType) {
      await bucket.put(key, body, { httpMetadata: { contentType } })
    },
    async head(key) {
      const object = await bucket.head(key)
      if (!object) return null
      return { byteSize: object.size, contentType: object.httpMetadata?.contentType ?? '' }
    },
    async delete(key) {
      await bucket.delete(key)
    },
  }
}
