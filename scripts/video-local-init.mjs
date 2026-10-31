import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
if (args.some(arg => arg === '--remote' || arg.includes('remote'))) {
  console.error('Refusing to touch a remote Cloudflare resource.')
  process.exit(1)
}

const root = fileURLToPath(new URL('..', import.meta.url))
const result = spawnSync(process.execPath, [
  'node_modules/wrangler/bin/wrangler.js',
  'd1',
  'migrations',
  'apply',
  'DB',
  '--local',
  '--config',
  'wrangler.video-local.jsonc',
  '--persist-to',
  '.wrangler/state/video-local',
], { cwd: root, stdio: 'inherit' })

if (result.status !== 0) process.exit(result.status ?? 1)
console.log('Local D1 migrations applied under .wrangler/state/video-local. No remote call was made.')
console.log('Mock fixture: workers/video-worker/fixtures/mock-video-v1.mp4')
