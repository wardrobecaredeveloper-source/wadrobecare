#!/usr/bin/env node
/**
 * Copy the Prisma client Wasm files into the Workers bundle directory
 * where Prisma's runtime loader expects to find them.
 *
 * Prisma's runtime resolves `query_compiler_bg.wasm` via `__dirname`.
 * On Cloudflare Workers, `__dirname` is `/bundle/node_modules/.prisma/client/`
 * (the original source path embedded in the bundled code).
 *
 * Vite/Rollup places the Wasm under `.cloudflare/output/v1/workers/default/bundle/ssr/_next/static/media/query_compiler_bg.<hash>.wasm`
 * with a content hash in the filename. The Prisma loader looks for it at
 * `/bundle/node_modules/.prisma/client/query_compiler_bg.wasm` (no hash).
 *
 * This script:
 *   1. Finds the hashed wasm file in the bundle.
 *   2. Copies it to the expected path (without the hash).
 *   3. Also writes the file at the bundle root path Prisma's loader uses.
 *
 * Run after `vite build` (the `build:vinext` script does this automatically).
 */

import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')

const bundleRoot = resolve(projectRoot, '.cloudflare/output/v1/workers/default/bundle')

// Step 1: find the hashed wasm file
const mediaDir = resolve(bundleRoot, 'ssr/_next/static/media')
if (!existsSync(mediaDir)) {
  console.error('[copy-prisma-wasm] media dir not found:', mediaDir)
  process.exit(1)
}

const wasmFiles = readdirSync(mediaDir).filter(
  (f) => f.startsWith('query_compiler_bg.') && f.endsWith('.wasm'),
)
if (wasmFiles.length === 0) {
  console.error('[copy-prisma-wasm] no query_compiler_bg.*.wasm file found in', mediaDir)
  process.exit(1)
}
const srcWasm = resolve(mediaDir, wasmFiles[0])
console.log(`[copy-prisma-wasm] source: ${srcWasm}`)

// Step 2: copy to the path Prisma expects on Workers (no content hash).
// Prisma's runtime calls `path.join(__dirname, 'query_compiler_bg.wasm')` where
// __dirname is `/bundle/node_modules/.prisma/client/` on the Workers runtime.
const targetDir = resolve(bundleRoot, 'node_modules/.prisma/client')
if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true })
const targetPath = resolve(targetDir, 'query_compiler_bg.wasm')
copyFileSync(srcWasm, targetPath)
console.log(`[copy-prisma-wasm] copied to: ${targetPath}`)

// Step 3: also place it at the bundle root for any code that resolves
// via `__dirname` at the bundle root.
const altTarget = resolve(bundleRoot, 'query_compiler_bg.wasm')
copyFileSync(srcWasm, altTarget)
console.log(`[copy-prisma-wasm] also copied to: ${altTarget}`)

console.log('[copy-prisma-wasm] done.')
