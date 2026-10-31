import type { TemplateInputField } from './templates'

export interface TemplateFieldValues {
  [key: string]: string
}

export function initialFieldValues(fields: readonly TemplateInputField[]): TemplateFieldValues {
  const values: TemplateFieldValues = {}
  for (const field of fields) values[field.key] = field.defaultValue ?? ''
  return values
}

export function validateTemplateFields(
  fields: readonly TemplateInputField[],
  values: Readonly<TemplateFieldValues>,
): Record<string, string> {
  const errors: Record<string, string> = {}
  const seen = new Set<string>()
  for (const field of fields) {
    if (seen.has(field.key)) {
      errors[field.key] = 'This field is duplicated.'
      continue
    }
    seen.add(field.key)
    const raw = values[field.key] ?? ''
    const value = field.type === 'select' ? raw : raw.trim()
    if (field.required && value.length === 0) {
      errors[field.key] = field.type === 'select'
        ? `Choose ${field.label.toLowerCase()}.`
        : `Enter ${field.label.toLowerCase()}.`
      continue
    }
    if (value.length > 0 && field.maxLength !== undefined && value.length > field.maxLength) {
      errors[field.key] = `${field.label} must be ${field.maxLength} characters or fewer.`
      continue
    }
    if (field.type === 'select' && value.length > 0) {
      const allowed = field.options?.some(option => option.value === value) ?? false
      if (!allowed) errors[field.key] = `Choose a valid ${field.label.toLowerCase()}.`
    }
  }
  return errors
}

export function normalizedFieldValues(
  fields: readonly TemplateInputField[],
  values: Readonly<TemplateFieldValues>,
): TemplateFieldValues {
  const next: TemplateFieldValues = {}
  for (const field of fields) {
    const raw = values[field.key] ?? ''
    next[field.key] = field.type === 'select' ? raw : raw.trim()
  }
  return next
}
