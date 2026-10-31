import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './packages/data/src/schema/index.ts',
  out: './drizzle',
  dialect: 'sqlite',
})

