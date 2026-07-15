const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const { MIGRATIONS_DIR, DATABASE_URL } = require('./paths');

// APPLIES PENDING prisma/migrations AT BOOT WITHOUT THE PRISMA CLI
const MIGRATIONS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                    TEXT PRIMARY KEY NOT NULL,
    "checksum"              TEXT NOT NULL,
    "finished_at"           DATETIME,
    "migration_name"        TEXT NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        DATETIME,
    "started_at"            DATETIME NOT NULL DEFAULT current_timestamp,
    "applied_steps_count"   INTEGER UNSIGNED NOT NULL DEFAULT 0
)`;

function splitStatements(sql) {
  return sql
    .split('\n')
    .filter(line => !line.trimStart().startsWith('--'))
    .join('\n')
    .split(/;[ \t]*(?:\r?\n|$)/)
    .map(stmt => stmt.trim())
    .filter(Boolean);
}

async function runMigrations(log = console) {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    log.warn(`No migrations directory at ${MIGRATIONS_DIR} - skipping schema migration`);
    return;
  }

  const pending = fs.readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  if (!pending.length) return;

  const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
  try {
    await prisma.$executeRawUnsafe(MIGRATIONS_TABLE_DDL);

    const rows = await prisma.$queryRawUnsafe(
      'SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"'
    );
    const failed = rows.filter(row => !row.finished_at && !row.rolled_back_at);
    if (failed.length) {
      throw new Error(
        `Migration(s) previously failed mid-apply: ${failed.map(row => row.migration_name).join(', ')}. ` +
        'Restore/delete the database (or resolve with `prisma migrate resolve`) before starting.'
      );
    }
    const applied = new Set(rows.filter(row => row.finished_at).map(row => row.migration_name));

    for (const name of pending) {
      if (applied.has(name)) continue;

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
      const statements = splitStatements(sql);
      const checksum = crypto.createHash('sha256').update(sql).digest('hex');

      await prisma.$transaction(async (tx) => {
        for (const statement of statements) {
          await tx.$executeRawUnsafe(statement);
        }
        await tx.$executeRawUnsafe(
          'INSERT INTO "_prisma_migrations" ("id", "checksum", "migration_name", "started_at", "finished_at", "applied_steps_count") ' +
          'VALUES (?, ?, ?, current_timestamp, current_timestamp, ?)',
          crypto.randomUUID(), checksum, name, statements.length
        );
      });
      log.info(`Applied migration ${name} (${statements.length} statements)`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

module.exports = { runMigrations };
