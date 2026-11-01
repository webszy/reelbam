import { TemplateEngineError } from './errors.ts'
import type { NormalizedTemplateInputs, TemplateInputField } from './types.ts'
import { assertTemplateInputFields, isTemplateFieldKey, validateTemplateInputs } from './validator.ts'

type PromptPart = { readonly text: string } | { readonly variable: string }

/** A deliberately small grammar. Braces must belong to a complete {{key}}. */
function parsePrompt(promptTemplate: string): PromptPart[] {
  const fail = (): never => { throw new TemplateEngineError('invalid_prompt', 'Invalid prompt placeholder syntax') }
  if (typeof promptTemplate !== 'string' || !promptTemplate.trim()) fail()
  const parts: PromptPart[] = []
  let cursor = 0
  while (cursor < promptTemplate.length) {
    const offset = promptTemplate.slice(cursor).search(/[{}]/)
    if (offset === -1) {
      parts.push({ text: promptTemplate.slice(cursor) })
      break
    }
    const start = cursor + offset
    if (start > cursor) parts.push({ text: promptTemplate.slice(cursor, start) })
    if (!promptTemplate.startsWith('{{', start)) fail()
    const end = promptTemplate.indexOf('}}', start + 2)
    if (end === -1) fail()
    const variable = promptTemplate.slice(start + 2, end).trim()
    if (!isTemplateFieldKey(variable)) fail()
    parts.push({ variable })
    cursor = end + 2
  }
  return parts
}

export function templatePromptVariables(promptTemplate: string, inputFields: readonly TemplateInputField[]): readonly string[] {
  assertTemplateInputFields(inputFields)
  const fields = new Set(inputFields.map(field => field.key))
  const variables = parsePrompt(promptTemplate).flatMap(part => 'variable' in part ? [part.variable] : [])
  if (variables.some(variable => !fields.has(variable))) {
    throw new TemplateEngineError('invalid_prompt', 'Prompt references an undeclared field')
  }
  return [...new Set(variables)]
}

/** Fields are mandatory so even a direct compiler call cannot invent variables. */
export function compileTemplatePrompt(
  promptTemplate: string,
  normalizedInputs: NormalizedTemplateInputs,
  inputFields: readonly TemplateInputField[],
): string {
  templatePromptVariables(promptTemplate, inputFields)
  const inputs = validateTemplateInputs({ inputFields }, normalizedInputs)
  return parsePrompt(promptTemplate).map((part) => {
    if ('text' in part) return part.text
    const value = inputs[part.variable]
    if (value === undefined) throw new TemplateEngineError('invalid_prompt', 'Prompt variable is missing')
    return value
  }).join('')
}
