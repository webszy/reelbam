// Node ESM resolve hook that lets the test runner import Nuxt app
// modules and the existing server service wrappers under plain `node` (type
// stripping). It maps the Nuxt `~`/`~~` aliases and resolves the extensionless
// TypeScript-relative imports used inside `server/`.

import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url)) // <root>/scripts
const ROOT = path.dirname(THIS_DIR)

function isProjectFile(fileUrl) {
  const p = fileURLToPath(fileUrl)
  return p.startsWith(ROOT + path.sep)
    && !p.includes(`${path.sep}node_modules${path.sep}`)
}

function toTsPath(target) {
  // The Nuxt aliases / relative project imports resolve to .ts source files.
  // Append the extension so the default Node ESM resolver finds them.
  return path.extname(target) === '' ? `${target}.ts` : target
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '~' || specifier.startsWith('~/')) {
    const rel = specifier === '~' ? '' : specifier.slice(2)
    const target = path.join(ROOT, 'app', rel)
    return nextResolve(pathToFileURL(toTsPath(target)).href, {
      ...context,
      parentURL: undefined,
    })
  }

  if (specifier === '~~' || specifier.startsWith('~~/')) {
    const rel = specifier === '~~' ? '' : specifier.slice(3)
    const target = path.join(ROOT, rel)
    return nextResolve(pathToFileURL(toTsPath(target)).href, {
      ...context,
      parentURL: undefined,
    })
  }

  // Extensionless relative imports within the project (e.g. `../utils/errors`)
  // resolve to their `.ts` sibling under type stripping.
  if (
    (specifier.startsWith('./') || specifier.startsWith('../'))
    && context.parentURL
    && isProjectFile(context.parentURL)
    && path.extname(specifier) === ''
  ) {
    const parentPath = fileURLToPath(context.parentURL)
    const resolved = path.resolve(path.dirname(parentPath), specifier)
    const candidate = `${resolved}.ts`
    if (existsSync(candidate)) {
      return nextResolve(pathToFileURL(candidate).href, {
        ...context,
        parentURL: undefined,
      })
    }

    // Directory-style relative imports with an index.ts.
    const indexCandidate = path.join(resolved, 'index.ts')
    if (existsSync(indexCandidate)) {
      return nextResolve(pathToFileURL(indexCandidate).href, {
        ...context,
        parentURL: undefined,
      })
    }
  }

  return nextResolve(specifier, context)
}
