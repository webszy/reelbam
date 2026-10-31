/** 只用于本包构造的普通配置/快照；不会保留调用者对象的可变引用。 */
export function frozenCopy<T>(value: T): T {
  const copy: T = structuredClone(value)
  function freeze(item: unknown): void {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child)
      Object.freeze(item)
    }
  }
  freeze(copy)
  return copy
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
