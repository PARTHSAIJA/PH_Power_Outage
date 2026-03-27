/**
 * Scraper runner — fetches all sources, deduplicates, and stores to DB.
 * Call runScrapers() to trigger a full refresh.
 */
const { v4: uuidv4 } = require('uuid');
const { db, initPromise } = require('../lib/database');

const sources = [
  require('./meralco'),
  require('./veco'),
  require('./dlpc'),
  require('./outage-report'),
];

// How long scraped outages stay active (hours)
const SCRAPE_TTL_HOURS = 6;

// Track last successful scrape per source to avoid hammering
const lastScrapeTime = {};
const MIN_SCRAPE_INTERVAL_MS = 25 * 60 * 1000; // 25 minutes

async function runScrapers() {
  await initPromise;
  console.log('[Scrapers] Starting run...');

  const now = Date.now();
  let totalAdded = 0;

  for (const source of sources) {
    // Rate-limit: skip if scraped recently
    if (lastScrapeTime[source.name] && (now - lastScrapeTime[source.name]) < MIN_SCRAPE_INTERVAL_MS) {
      console.log(`[Scrapers] Skipping ${source.name} (scraped recently)`);
      continue;
    }

    try {
      console.log(`[Scrapers] Fetching ${source.name}...`);
      const items = await source.scrape();
      console.log(`[Scrapers] ${source.name}: ${items.length} items found`);

      for (const item of items) {
        await upsertOutage(item);
        totalAdded++;
      }

      lastScrapeTime[source.name] = Date.now();
    } catch (err) {
      console.warn(`[Scrapers] ${source.name} failed: ${err.message}`);
      // Don't throw — one failing source shouldn't break others
    }
  }

  // Clean up expired scraped outages
  try {
    const del = await db.execute({
      sql: `DELETE FROM outages WHERE expires_at <= datetime('now') AND source != 'crowdsourced'`,
      args: [],
    });
    if (del.rowsAffected > 0) {
      console.log(`[Scrapers] Cleaned ${del.rowsAffected} expired scraped outages`);
    }
  } catch (err) {
    console.warn('[Scrapers] Cleanup error:', err.message);
  }

  console.log(`[Scrapers] Done. ${totalAdded} items processed.`);
  return totalAdded;
}

async function upsertOutage(item) {
  // Build a dedup key from source + approximate location + description snippet
  const dedupKey = `${item.source}:${item.lat.toFixed(2)}:${item.lng.toFixed(2)}:${(item.description || '').slice(0, 60)}`;
  const dedupHash = require('crypto').createHash('md5').update(dedupKey).digest('hex').slice(0, 12);

  // Check if we already have a recent entry with this dedup hash
  const existing = await db.execute({
    sql: `SELECT id FROM outages WHERE reporter_hash = ? AND expires_at > datetime('now')`,
    args: [dedupHash],
  });
  if (existing.rows.length > 0) return; // Already stored, skip

  const now = new Date();
  const expiresAt = new Date(now.getTime() + SCRAPE_TTL_HOURS * 60 * 60 * 1000);

  await db.execute({
    sql: `INSERT INTO outages
          (id, lat, lng, region, province, city, barangay, description, type,
           reported_at, expires_at, upvotes, reporter_hash, source, source_url, affected_areas)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    args: [
      uuidv4(),
      item.lat, item.lng,
      item.region || 'Unknown',
      item.province || null,
      item.city || null,
      item.barangay || null,
      (item.description || '').slice(0, 500),
      item.type || 'unplanned',
      now.toISOString(),
      expiresAt.toISOString(),
      dedupHash,
      item.source,
      item.source_url || null,
      item.affected_areas || null,
    ],
  });
}

module.exports = { runScrapers };
