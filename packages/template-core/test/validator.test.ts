import assert from 'node:assert/strict'
import test from 'node:test'
import { validateTemplateInputs } from '../src/validator.ts'
import { definition, errorCode } from './fixtures.ts'

const template = definition()

test('normalizes declared strings, supplies explicit select default and optional empty value', () => {
  assert.deepEqual(validateTemplateInputs(template, { subject: '  A white cat  ' }), {
    subject: 'A white cat', style: 'quiet', details: '',
  })
})

test('normalizes blank defaulted values and select whitespace consistently', () => {
  assert.deepEqual(validateTemplateInputs(template, { subject: 'A cat', style: '  ', details: ' \n ' }), {
    subject: 'A cat', style: 'quiet', details: '',
  })
  assert.equal(validateTemplateInputs(template, { subject: 'A cat', style: ' bright ' }).style, 'bright')
})

test('required fields can use a validated default', () => {
  const inputFields = [{ key: 'subject', type: 'text' as const, required: true, defaultValue: 'A cat' }]
  assert.deepEqual(validateTemplateInputs({ inputFields }, {}), { subject: 'A cat' })
})

test('accepts safe null-prototype input objects without relying on inherited methods', () => {
  const inputs: Record<string, string> = Object.create(null)
  inputs.subject = 'A cat'
  assert.equal(validateTemplateInputs(template, inputs).subject, 'A cat')
})

const invalidInputs: readonly [string, unknown][] = [
  ['missing required field', {}],
  ['blank required field', { subject: ' \n\t ' }],
  ['minimum length', { subject: 'x' }],
  ['maximum length', { subject: 'x'.repeat(81) }],
  ['textarea maximum length', { subject: 'A cat', details: 'x'.repeat(281) }],
  ['invalid select', { subject: 'A cat', style: 'unknown' }],
  ['unknown field', { subject: 'A cat', modelId: 'other-model' }],
  ['client resolution', { subject: 'A cat', resolution: '1080p' }],
  ['object as string', { subject: { text: 'A cat' } }],
  ['array as string', { subject: ['A cat'] }],
  ['number as string', { subject: 12 }],
  ['null as string', { subject: null }],
  ['explicit undefined', { subject: 'A cat', details: undefined }],
  ['array payload', ['A cat']],
  ['string payload', 'A cat'],
  ['null payload', null],
  ['undefined payload', undefined],
  ['custom prototype', Object.assign(Object.create({ inherited: 'value' }), { subject: 'A cat' })],
  ['prototype key', JSON.parse('{"subject":"A cat","__proto__":{"polluted":true}}')],
  ['constructor key', { subject: 'A cat', constructor: 'bad' }],
  ['symbol key', { subject: 'A cat', [Symbol('hidden')]: 'bad' }],
]
for (const [label, inputs] of invalidInputs) {
  test(`rejects ${label}`, () => assert.throws(() => validateTemplateInputs(template, inputs), errorCode('invalid_inputs')))
}

test('rejects accessors without executing user code', () => {
  let reads = 0
  const inputs = Object.defineProperty({}, 'subject', { get() { reads += 1; return 'A cat' }, enumerable: true })
  assert.throws(() => validateTemplateInputs(template, inputs), errorCode('invalid_inputs'))
  assert.equal(reads, 0)
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false)
})

test('rejects duplicate input field definitions', () => {
  const field = template.inputFields[0]!
  assert.throws(() => validateTemplateInputs({ inputFields: [field, field] }, { subject: 'A cat' }), errorCode('invalid_template'))
})

for (const key of ['__proto__', 'prototype', 'constructor', 'toString', 'hasOwnProperty', 'subject.name', 'bad-key', '', 'x'.repeat(65)]) {
  test(`rejects unsafe field definition ${JSON.stringify(key)}`, () => {
    const inputFields = [{ key, type: 'text' as const, required: false }]
    assert.throws(() => validateTemplateInputs({ inputFields }, {}), errorCode('invalid_template'))
  })
}

test('validates default values, select options and length limits before using inputs', () => {
  for (const field of [
    { key: 'value', type: 'select' as const, required: false, defaultValue: 'bad', options: [{ value: 'good' }] },
    { key: 'value', type: 'text' as const, required: true, defaultValue: '   ' },
    { key: 'value', type: 'text' as const, required: false, defaultValue: 'long', maxLength: 2 },
    { key: 'value', type: 'text' as const, required: false, defaultValue: 'x', minLength: 2 },
    { key: 'value', type: 'text' as const, required: false, minLength: 3, maxLength: 2 },
    { key: 'value', type: 'text' as const, required: false, maxLength: -1 },
    { key: 'value', type: 'select' as const, required: false, options: [{ value: 'same' }, { value: 'same' }] },
    { key: 'value', type: 'select' as const, required: false, options: [] },
  ]) {
    assert.throws(() => validateTemplateInputs({ inputFields: [field] }, {}), errorCode('invalid_template'))
  }
})
