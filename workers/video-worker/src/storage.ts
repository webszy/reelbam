import type { VideoObjectStore } from '../../../packages/data/src/video/protocol.ts'
import type { VideoObjectBinding } from './bindings.ts'

export function r2ObjectStore(bucket: VideoObjectBinding): VideoObjectStore {
  return {
    async put(key, body, contentType, contentHash) {
      await bucket.put(key, body, { httpMetadata: { contentType },
        onlyIf: { etagDoesNotMatch: '*' }, sha256: contentHash })
    },
    async head(key) {
      const object = await bucket.head(key)
      if (!object) return null
      const contentHash = object.checksums.sha256
        ? Array.from(new Uint8Array(object.checksums.sha256), byte => byte.toString(16).padStart(2, '0')).join('')
        : ''
      return { byteSize: object.size, contentType: object.httpMetadata?.contentType ?? '', contentHash }
    },
    async delete(key) {
      await bucket.delete(key)
    },
    async list(prefix, limit, cursor) {
      const page = await bucket.list({ prefix, limit, ...(cursor ? { cursor } : {}) })
      return { objects: page.objects.map(object => ({ key: object.key, uploadedAtMs: object.uploaded.getTime() })),
        ...(page.truncated && page.cursor ? { cursor: page.cursor } : {}) }
    },
  }
}
