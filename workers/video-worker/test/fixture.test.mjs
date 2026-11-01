import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { MOCK_FIXTURE_BYTES, MOCK_FIXTURE_SHA256 } from '../src/fixture.ts'

const fixture = new URL('../fixtures/mock-video-v1.mp4', import.meta.url)

test('Mock runtime bytes equal a small, hashed MP4 with a video track', () => {
  const bytes = readFileSync(fixture)
  assert.deepEqual(new Uint8Array(bytes), MOCK_FIXTURE_BYTES)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), MOCK_FIXTURE_SHA256)
  assert.ok(bytes.length > 53 && bytes.length < 5_000_000)
  for (const box of ['ftyp', 'moov', 'trak', 'mdia', 'vide', 'avc1', 'mdat']) assert.ok(bytes.includes(Buffer.from(box)), box)
})

test('Mock fixture decodes to ten H.264 video frames with FFmpeg', t => {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', fixture.pathname,
    '-map', '0:v:0', '-f', 'null', '-'], { encoding: 'utf8' })
  if (result.error?.code === 'ENOENT') return t.skip('FFmpeg not installed; structural/hash and R2 checks still run')
  assert.equal(result.status, 0, result.stderr)
})
