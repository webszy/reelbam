import type { RouteSnapshot } from '@reelbam/video-contracts/internal'
import type { ProviderAdapter } from '../provider.ts'
import { isNonBlank } from '../value.ts'

export class ProviderRegistry {
  readonly #adapters: readonly ProviderAdapter[]

  constructor(adapters: readonly ProviderAdapter[]) {
    const identities = new Set<string>()
    for (const adapter of adapters) {
      const identity = JSON.stringify([adapter.id, adapter.adapterVersion])
      if (!isNonBlank(adapter.id) || !isNonBlank(adapter.adapterVersion) || identities.has(identity)) {
        throw new Error('Invalid or duplicate Provider adapter identity')
      }
      identities.add(identity)
    }
    // 固定注册标识和方法绑定；后续注册新版本不替换旧快照需要的版本。
    this.#adapters = adapters.map(adapter => Object.freeze({
      id: adapter.id,
      adapterVersion: adapter.adapterVersion,
      submissionIdempotency: adapter.submissionIdempotency,
      submit: adapter.submit.bind(adapter),
      getStatus: adapter.getStatus.bind(adapter),
      ...(adapter.projectSubmission ? { projectSubmission: adapter.projectSubmission.bind(adapter) } : {}),
      ...(adapter.recoverSubmission ? { recoverSubmission: adapter.recoverSubmission.bind(adapter) } : {}),
      ...(adapter.cancel ? { cancel: adapter.cancel.bind(adapter) } : {}),
    }))
  }

  get(id: string, version: string): ProviderAdapter | undefined {
    return this.#adapters.find(adapter => adapter.id === id && adapter.adapterVersion === version)
  }

  /** 恢复只依据已保存的 Provider 和版本，不查询当前默认模型或路线。 */
  forSnapshot(snapshot: RouteSnapshot): ProviderAdapter {
    const adapter = this.get(snapshot.providerId, snapshot.adapterVersion)
    if (!adapter) throw new Error(`Provider adapter unavailable: ${snapshot.providerId}@${snapshot.adapterVersion}`)
    return adapter
  }
}
