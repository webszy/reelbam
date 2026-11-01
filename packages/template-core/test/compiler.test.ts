import assert from 'node:assert/strict'
import test from 'node:test'
import { compileTemplatePrompt } from '../src/compiler.ts'
import { definition, errorCode } from './fixtures.ts'

const template = definition()
const compile = (prompt: string, inputs: Readonly<Record<string, string>>) => compileTemplatePrompt(prompt, inputs, template.inputFields)

test('interpolates simple variables and preserves surrounding literal text', () => {
  assert.equal(compile('Subject: {{ subject }}. Style: {{style}}.', { subject: 'A cat', style: 'bright' }), 'Subject: A cat. Style: bright.')
})

test('optional variables and defaults use the declared normalization rules', () => {
  assert.equal(compile(template.promptTemplate, { subject: 'A cat' }), 'Subject: A cat. Style: quiet. Details: .')
})

test('missing required variables fail instead of silently becoming empty strings', () => {
  assert.throws(() => compile('{{subject}}', {}), errorCode('invalid_inputs'))
})

test('unknown variables fail even when their value is supplied by the caller', () => {
  assert.throws(() => compile('{{unknown}}', { subject: 'A cat', unknown: 'bad' }), errorCode('invalid_prompt'))
})

for (const prompt of ['{{subject', '{{}}', '{{subject.name}}', '{{subject()}}', '{{subject | upper}}', '{{subject + style}}', '{{{subject}}}', '{{subject}}}', 'subject}}', '{subject}', '{{subject}']) {
  test(`rejects malformed or executable placeholder ${JSON.stringify(prompt)}`, () => {
    assert.throws(() => compile(prompt, { subject: 'A cat' }), errorCode('invalid_prompt'))
  })
}

test('user values containing placeholder syntax are inserted once, verbatim', () => {
  assert.equal(compile('{{subject}} / {{style}} / {{subject}}', { subject: '{{style}}', style: 'bright' }), '{{style}} / bright / {{style}}')
  assert.equal(compile('{{subject}}', { subject: '{{process.exit()}}' }), '{{process.exit()}}')
})

test('input order does not change output and replacement metacharacters stay literal', () => {
  const forward = { subject: '$& $$ $1', style: 'bright', details: 'rain' }
  const reverse = { details: 'rain', style: 'bright', subject: '$& $$ $1' }
  assert.equal(compile(template.promptTemplate, forward), compile(template.promptTemplate, reverse))
  assert.match(compile('{{subject}}', forward), /^\$& \$\$ \$1$/)
})
