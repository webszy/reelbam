import { register } from 'node:module'
import { $fetch } from 'ofetch'
register(new URL('./alias-loader.mjs', import.meta.url))
globalThis.$fetch ??= $fetch
