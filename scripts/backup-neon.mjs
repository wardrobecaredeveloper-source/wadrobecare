#!/usr/bin/env node
/**
 * Neon database backup — pre-deployment safeguard.
 *
 * Usage (run from your local machine where you have the Neon URL):
 *
 *   DATABASE_URL="postgresql://user:pass@host/db?sslmode=require" \
 *     node scripts/backup-neon.mjs
 *
 * Or:
 *   export DATABASE_URL="postgresql://…"
 *   node scripts/backup-neon.mjs
 *
 * Produces a SQL dump (CREATE TABLE + INSERT) saved to
 *   download/backups/neon-backup-YYYY-MM-DD-HHMMSS.sql
 *
 * This script uses Node's built-in `pg` driver (already installed).
 * It connects to Neon in READ-ONLY mode, queries every table, and
 * writes a portable SQL file. Safe to run against production —
 * it never issues a write.
 *
 * The backup must run BEFORE the Cloudflare deploy, and you should
 * keep the resulting .sql file until after the new Worker is
 * verified end-to-end (auth, Paystack, orders, email).
 */

import { resolve, join } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { Pool } from 'pg'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error(
    'Error: DATABASE_URL is not set.\n' +
      'Pass it as an env var, e.g.:\n' +
      '  DATABASE_URL="postgresql://user:pass@host/db?sslmode=require" node scripts/backup-neon.mjs',
  )
  process.exit(1)
}

const projectRoot = resolve(import.meta.dirname, '..')
const backupDir = join(projectRoot, 'download', 'backups')
if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true })

const ts = new Date()
  .toISOString()
  .replace(/[:T]/g, '-')
  .replace(/\..+$/, '')
const outPath = join(backupDir, `neon-backup-${ts}.sql`)

console.log(`[backup] connecting to Neon…`)
console.log(`[backup] target file: ${outPath}`)

const pool = new Pool({
  connectionString: DATABASE_URL,
  // Neon requires SSL.
  ssl: { rejectUnauthorized: false },
  // Single connection — we read sequentially.
  max: 1,
  connectionTimeoutMillis: 30000,
})

async function main() {
  let client
  try {
    client = await pool.connect()
    console.log('[backup] connected.')

    // Set READ-ONLY transaction to be extra safe.
    await client.query('BEGIN READ ONLY')

    // 1. Schema dump (CREATE TABLE statements via pg_get_tabledef won't work
    //    on Neon — use information_schema + pg_catalog queries instead).
    const tablesRes = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name;
    `)

    const tableNames = tablesRes.rows.map((r) => r.table_name)
    console.log(`[backup] found ${tableNames.length} tables.`)

    const sqlChunks = []
    sqlChunks.push(`-- Wardrobecare Neon backup`)
    sqlChunks.push(`-- Generated: ${new Date().toISOString()}`)
    sqlChunks.push(`-- Database: ${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`)
    sqlChunks.push(`-- Tables: ${tableNames.length}`)
    sqlChunks.push(``)
    sqlChunks.push(`SET client_encoding = 'UTF8';`)
    sqlChunks.push(`SET standard_conforming_strings = on;`)
    sqlChunks.push(``)

    let totalRows = 0

    for (const table of tableNames) {
      console.log(`[backup] dumping table: ${table}`)
      // Get columns in order
      const colsRes = await client.query(
        `
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position;
        `,
        [table],
      )
      const columns = colsRes.rows.map((r) => r.column_name)
      if (columns.length === 0) continue

      const colList = columns.map((c) => `"${c}"`).join(', ')
      // Read in batches of 5000 rows to keep memory bounded.
      let offset = 0
      const batchSize = 5000
      let tableRows = 0

      sqlChunks.push(`--`)
      sqlChunks.push(`-- Data for table: ${table} (${columns.length} columns)`)
      sqlChunks.push(`--`)

      while (true) {
        const dataRes = await client.query(
          `SELECT ${colList} FROM "${table}" ORDER BY ctid LIMIT $1 OFFSET $2;`,
          [batchSize, offset],
        )
        if (dataRes.rows.length === 0) break
        for (const row of dataRes.rows) {
          const values = columns.map((c) => toSqlLiteral(row[c]))
          sqlChunks.push(
            `INSERT INTO "${table}" (${colList}) VALUES (${values.join(', ')});`,
          )
        }
        tableRows += dataRes.rows.length
        totalRows += dataRes.rows.length
        offset += batchSize
        if (dataRes.rows.length < batchSize) break
      }
      sqlChunks.push(``)
      console.log(`[backup]   ${table}: ${tableRows} rows`)
    }

    await client.query('COMMIT')

    writeFileSync(outPath, sqlChunks.join('\n'))
    console.log(``)
    console.log(`[backup] DONE.`)
    console.log(`[backup] file: ${outPath}`)
    console.log(`[backup] total rows: ${totalRows}`)
    console.log(`[backup] size: ${(sqlChunks.join('\n').length / 1024).toFixed(1)} KB`)
  } catch (err) {
    console.error(`[backup] FAILED:`, err)
    if (client) {
      try {
        await client.query('ROLLBACK')
      } catch {}
    }
    process.exit(1)
  } finally {
    if (client) client.release()
    await pool.end()
  }
}

/**
 * Convert a JS value to a PostgreSQL literal for an INSERT statement.
 * Handles null, boolean, number, string, Date, array, and object (JSON).
 */
function toSqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (v instanceof Date) return `'${v.toISOString()}'`
  if (Array.isArray(v)) {
    return `ARRAY[${v.map(toSqlLiteral).join(', ')}]`
  }
  if (typeof v === 'object') {
    // JSON / JSONB column — escape as string literal
    return `'${JSON.stringify(v).replace(/'/g, "''")}'`
  }
  // String fallback — escape single quotes
  return `'${String(v).replace(/'/g, "''").replace(/\\/g, '\\\\')}'`
}

main().catch((err) => {
  console.error('[backup] uncaught error:', err)
  process.exit(1)
})
