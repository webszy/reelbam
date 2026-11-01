import { TemplateEngineError } from './errors.ts'
import type { NormalizedTemplateInputs, TemplateInputField } from './types.ts'

const RESERVED_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype'])

export function isTemplateFieldKey(key: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) && !RESERVED_KEYS.has(key)
}

function invalidDefinition(field?: string): never {
  throw new TemplateEngineError('invalid_template', 'Invalid template input field definition', field ? { field } : {})
}

function normalizedValue(field: TemplateInputField, raw: string, code: 'invalid_template' | 'invalid_inputs'): string {
  const value = raw.trim()
  const reject = (message: string): never => {
    throw new TemplateEngineError(code, message, { field: field.key })
  }
  if (!value && field.required) reject('Required field is missing or blank')
  if (field.maxLength !== undefined && value.length > field.maxLength) reject('Field exceeds maximum length')
  if (value && field.minLength !== undefined && value.length < field.minLength) reject('Field is shorter than minimum length')
  if (value && field.type === 'select' && !field.options?.some(option => option.value === value)) {
    reject('Select value is not an allowed option')
  }
  return value
}

export function assertTemplateInputFields(fields: readonly TemplateInputField[]): void {
  if (!Array.isArray(fields)) invalidDefinition()
  const keys = new Set<string>()
  for (const field of fields) {
    if (!field || typeof field.key !== 'string' || !isTemplateFieldKey(field.key) || keys.has(field.key)) invalidDefinition()
    keys.add(field.key)
    if (!['text', 'textarea', 'select'].includes(field.type) || typeof field.required !== 'boolean') invalidDefinition(field.key)
    for (const limit of [field.minLength, field.maxLength]) {
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) invalidDefinition(field.key)
    }
    if (field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength) invalidDefinition(field.key)
    if (field.type === 'select') {
      if (!Array.isArray(field.options) || !field.options.length) invalidDefinition(field.key)
      const options = new Set<string>()
      for (const option of field.options) {
        if (!option || typeof option.value !== 'string' || !option.value.trim()
          || option.value !== option.value.trim() || options.has(option.value)) invalidDefinition(field.key)
        options.add(option.value)
      }
    }
    if (field.defaultValue !== undefined) {
      if (typeof field.defaultValue !== 'string') invalidDefinition(field.key)
      normalizedValue(field, field.defaultValue, 'invalid_template')
    }
  }
}

/** Missing/blank fields use an explicit default, then optional empty string. */
export function validateTemplateInputs(
  definition: { readonly inputFields: readonly TemplateInputField[] },
  unknownInputs: unknown,
): NormalizedTemplateInputs {
  assertTemplateInputFields(definition.inputFields)
  if (unknownInputs === null || typeof unknownInputs !== 'object' || Array.isArray(unknownInputs)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(unknownInputs))) {
    throw new TemplateEngineError('invalid_inputs', 'Inputs must be a plain field object')
  }
  const fields = new Set(definition.inputFields.map(field => field.key))
  const supplied = new Map<string, string>()
  for (const key of Reflect.ownKeys(unknownInputs)) {
    if (typeof key !== 'string' || !isTemplateFieldKey(key) || !fields.has(key)) {
      throw new TemplateEngineError('invalid_inputs', 'Unknown or forbidden input field')
    }
    const descriptor = Object.getOwnPropertyDescriptor(unknownInputs, key)
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') {
      throw new TemplateEngineError('invalid_inputs', 'Field must be a string data property', { field: key })
    }
    supplied.set(key, descriptor.value)
  }
  const normalized: Record<string, string> = {}
  for (const field of definition.inputFields) {
    const raw = supplied.get(field.key)
    const value = raw === undefined || raw.trim() === '' ? field.defaultValue ?? '' : raw
    normalized[field.key] = normalizedValue(field, value, 'invalid_inputs')
  }
  return Object.freeze(normalized)
}
