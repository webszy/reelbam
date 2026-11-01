import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('..', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'reelbam-bindings-'))

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: root, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('VIDEO_BINDING_CHECK_FAILED:' + result.status)
}

try {
  const types = join(directory, 'bindings.d.ts')
  const check = join(directory, 'check.ts')
  run([join(root, 'node_modules/wrangler/bin/wrangler.js'), 'types', types,
    '--config', 'workers/video-worker/wrangler.jsonc', '--env-interface', 'VideoWorkerBindings', '--strict-vars=false'])
  writeFileSync(check, [
    `import worker from ${JSON.stringify(join(root, 'workers/video-worker/src/index.ts'))}`,
    `import type { VideoWorkerEnv } from ${JSON.stringify(join(root, 'workers/video-worker/src/bindings.ts'))}`,
    'declare const actual: VideoWorkerBindings',
    'const env: VideoWorkerEnv = actual',
    'const handler: ExportedHandler<VideoWorkerBindings> = worker',
    'void env; void handler',
  ].join('\n'))
  const config = join(directory, 'tsconfig.json')
  writeFileSync(config, JSON.stringify({
    extends: join(root, 'tsconfig.video.json'),
    compilerOptions: { typeRoots: [join(root, 'node_modules/@types')] },
    include: [types, check],
  }))
  run([join(root, 'node_modules/typescript/bin/tsc'), '--project', config])
  console.log('Video Worker matches the generated Wrangler bindings and handler types.')
}
finally {
  rmSync(directory, { recursive: true, force: true })
}
