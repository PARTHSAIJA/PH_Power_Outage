const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'outages.db');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
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
    reporter_hash TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_outages_expires ON outages(expires_at);
  CREATE INDEX IF NOT EXISTS idx_outages_region ON outages(region);
  CREATE INDEX IF NOT EXISTS idx_outages_reported ON outages(reported_at);

  CREATE TABLE IF NOT EXISTS upvotes (
    outage_id TEXT NOT NULL,
    voter_hash TEXT NOT NULL,
    voted_at TEXT NOT NULL,
    PRIMARY KEY (outage_id, voter_hash),
    FOREIGN KEY (outage_id) REFERENCES outages(id) ON DELETE CASCADE
  );
`);

// Prepared statements
const stmts = {
  insertOutage: db.prepare(`
    INSERT INTO outages (id, lat, lng, region, province, city, barangay, description, type, reported_at, expires_at, reporter_hash)
    VALUES (@id, @lat, @lng, @region, @province, @city, @barangay, @description, @type, @reported_at, @expires_at, @reporter_hash)
  `),

  getActiveOutages: db.prepare(`
    SELECT * FROM outages
    WHERE expires_at > datetime('now')
    ORDER BY reported_at DESC
  `),

  getOutageById: db.prepare(`SELECT * FROM outages WHERE id = ?`),

  upvoteOutage: db.prepare(`UPDATE outages SET upvotes = upvotes + 1 WHERE id = ?`),

  hasVoted: db.prepare(`SELECT 1 FROM upvotes WHERE outage_id = ? AND voter_hash = ?`),

  insertVote: db.prepare(`
    INSERT INTO upvotes (outage_id, voter_hash, voted_at)
    VALUES (?, ?, datetime('now'))
  `),

  deleteExpired: db.prepare(`DELETE FROM outages WHERE expires_at <= datetime('now')`),

  getStats: db.prepare(`
    SELECT
      region,
      COUNT(*) as count,
      SUM(upvotes) as total_upvotes
    FROM outages
    WHERE expires_at > datetime('now')
    GROUP BY region
    ORDER BY count DESC
  `),

  getRecentCount: db.prepare(`
    SELECT COUNT(*) as count FROM outages
    WHERE expires_at > datetime('now')
  `),

  checkReporterLimit: db.prepare(`
    SELECT COUNT(*) as count FROM outages
    WHERE reporter_hash = ?
    AND reported_at > datetime('now', '-1 hour')
  `)
};

module.exports = { db, stmts };
