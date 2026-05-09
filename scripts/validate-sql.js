#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sqlPath = join(root, 'migrations/0001_init.sql');

async function main() {
  const sql = await readFile(sqlPath, 'utf8');
  const db = new Database(':memory:');
  try {
    db.exec(sql);
  } catch (err) {
    console.error(`SQL validation FAILED: ${err.message}`);
    process.exit(1);
  }
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  const expected = [
    'issue_analyses',
    'issue_comments',
    'issues',
    'poll_state',
    'projects',
    'sessions',
    'user_ratings',
    'users',
    'versions',
  ];
  const missing = expected.filter((t) => !tables.includes(t));
  if (missing.length) {
    console.error(`Missing tables: ${missing.join(', ')}`);
    console.error(`Got: ${tables.join(', ')}`);
    process.exit(1);
  }
  console.log(`✔ SQL valid · tables: ${tables.join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
