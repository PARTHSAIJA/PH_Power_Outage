const { createClient } = require('@libsql/client');
const path = require('path');
const fs = require('fs');

// For local dev, use a local SQLite file. On Vercel, use Turso via env vars.
const dbUrl = process.env.TURSO_DATABASE_URL || 'file:./data/outages.db';

// Ensure local data directory exists when using file-based SQLite
if (dbUrl.startsWith('file:')) {
  const filePath = dbUrl.replace('file:', '');
  const dir = path.dirname(path.resolve(filePath));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const db = createClient({
  url: dbUrl,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Initialize tables — awaited before first request via initPromise
const initPromise = (async () => {
  // Create tables
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS outages (
      id TEXT PRIMARY KEY,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      region TEXT NOT NULL,
      province TEXT,
      city TEXT,
      barangay TEXT,
      description TEXT,
      type TEXT NOT NULL DEFAULT 'unplanned',
      reported_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      upvotes INTEGER NOT NULL DEFAULT 0,
      reporter_hash TEXT,
      source TEXT NOT NULL DEFAULT 'crowdsourced',
      source_url TEXT,
      affected_areas TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_outages_expires ON outages(expires_at);
    CREATE INDEX IF NOT EXISTS idx_outages_region ON outages(region);
    CREATE INDEX IF NOT EXISTS idx_outages_reported ON outages(reported_at);

    CREATE TABLE IF NOT EXISTS upvotes (
      outage_id TEXT NOT NULL,
      voter_hash TEXT NOT NULL,
      voted_at TEXT NOT NULL,
      PRIMARY KEY (outage_id, voter_hash)
    );
  `);

  // Migrations: add columns that may not exist in older DBs
  const migrations = [
    `ALTER TABLE outages ADD COLUMN source TEXT NOT NULL DEFAULT 'crowdsourced'`,
    `ALTER TABLE outages ADD COLUMN source_url TEXT`,
    `ALTER TABLE outages ADD COLUMN affected_areas TEXT`,
  ];
  for (const sql of migrations) {
    try { await db.execute({ sql, args: [] }); } catch { /* column already exists */ }
  }
})();

module.exports = { db, initPromise };
