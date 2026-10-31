import assert from 'node:assert/strict'
import test from 'node:test'
import { renderPrivatePrompt } from './private.ts'
import { prepareTextToVideo } from './text-to-video.ts'

test('text-to-video prepare stays closed and does not return a prompt', () => {
  const closed = prepareTextToVideo('neon-night')
  assert.deepEqual(closed, { available: false, reason: 'generation_not_open' })
  assert.equal('prompt' in closed, false)
  assert.deepEqual(prepareTextToVideo('lantern-draft'), { available: false, reason: 'unknown_template' })
  assert.deepEqual(prepareTextToVideo('not-a-template'), { available: false, reason: 'unknown_template' })
})

test('private prompt rendering stays on the server helper', () => {
  const rendered = renderPrivatePrompt('neon-night', {
    character: 'a courier',
    action: 'walks',
    mood: 'quiet',
    details: 'rain',
  })
  assert.ok(rendered)
  assert.match(rendered, /internal-template-prompt neon-night/)
  assert.match(rendered, /a courier/)
  assert.doesNotMatch(rendered, /\{\{character\}\}/)
  assert.equal(renderPrivatePrompt('lantern-draft', {}), undefined)
})
