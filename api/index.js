const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const { db, initPromise } = require('../lib/database');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files — on Vercel these are served by CDN before hitting here,
// but this keeps local `node server.js` working without changes.
app.use(express.static(path.join(__dirname, '..', 'public')));

// Rate limiting
const reportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many reports submitted. Please wait before reporting again.' },
});

const voteLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  message: { error: 'Too many votes. Please slow down.' },
});

// Helper: anonymize IP
function hashIP(req) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.socket.remoteAddress
    || 'unknown';
  return crypto.createHash('sha256')
    .update(ip + (process.env.HASH_SALT || 'ph-outage-salt-2024'))
    .digest('hex').slice(0, 16);
}

// Valid Philippine regions
const PH_REGIONS = new Set([
  'NCR', 'CAR', 'Region I', 'Region II', 'Region III', 'Region IV-A',
  'Region IV-B', 'Region V', 'Region VI', 'Region VII', 'Region VIII',
  'Region IX', 'Region X', 'Region XI', 'Region XII', 'Region XIII',
  'BARMM', 'Unknown',
]);

// Ensure DB is initialized before any request
app.use(async (_req, _res, next) => {
  try {
    await initPromise;
    next();
  } catch (err) {
    next(err);
  }
});

// ─── ROUTES ─────────────────────────────────────────────────────────────────

// GET /api/outages
app.get('/api/outages', async (req, res) => {
  try {
    const result = await db.execute({
      sql: `SELECT * FROM outages WHERE expires_at > datetime('now') ORDER BY reported_at DESC`,
      args: [],
    });
    res.json({ outages: result.rows, count: result.rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch outages' });
  }
});

// GET /api/stats
app.get('/api/stats', async (req, res) => {
  try {
    const [statsResult, countResult] = await Promise.all([
      db.execute({
        sql: `SELECT region, COUNT(*) as count, SUM(upvotes) as total_upvotes
              FROM outages WHERE expires_at > datetime('now')
              GROUP BY region ORDER BY count DESC`,
        args: [],
      }),
      db.execute({
        sql: `SELECT COUNT(*) as count FROM outages WHERE expires_at > datetime('now')`,
        args: [],
      }),
    ]);
    res.json({
      byRegion: statsResult.rows,
      total: Number(countResult.rows[0]?.count ?? 0),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// POST /api/outages
app.post('/api/outages', reportLimiter, async (req, res) => {
  const { lat, lng, region, province, city, barangay, description, type } = req.body;

  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'Valid coordinates required' });
  }
  if (lat < 4.5 || lat > 21.5 || lng < 116 || lng > 127) {
    return res.status(400).json({ error: 'Coordinates must be within the Philippines' });
  }
  if (!region || !PH_REGIONS.has(region)) {
    return res.status(400).json({ error: 'Valid Philippine region required' });
  }
  if (type && !['unplanned', 'planned'].includes(type)) {
    return res.status(400).json({ error: 'Type must be unplanned or planned' });
  }
  if (description && description.length > 500) {
    return res.status(400).json({ error: 'Description must be under 500 characters' });
  }

  const reporterHash = hashIP(req);

  // Max 5 reports per hour per IP
  const limitCheck = await db.execute({
    sql: `SELECT COUNT(*) as count FROM outages
          WHERE reporter_hash = ? AND reported_at > datetime('now', '-1 hour')`,
    args: [reporterHash],
  });
  if (Number(limitCheck.rows[0]?.count ?? 0) >= 5) {
    return res.status(429).json({ error: 'You have reported too many outages recently. Please wait.' });
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 6 * 60 * 60 * 1000);
  const id = uuidv4();
  const outageType = type || 'unplanned';
  const desc = description ? description.trim().slice(0, 500) : null;

  await db.execute({
    sql: `INSERT INTO outages
          (id, lat, lng, region, province, city, barangay, description, type, reported_at, expires_at, reporter_hash)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, lat, lng, region, province || null, city || null, barangay || null,
           desc, outageType, now.toISOString(), expiresAt.toISOString(), reporterHash],
  });

  res.status(201).json({
    success: true,
    outage: { id, lat, lng, region, province, city, barangay, description: desc,
              type: outageType, reported_at: now.toISOString(),
              expires_at: expiresAt.toISOString(), upvotes: 0 },
  });
});

// POST /api/outages/:id/upvote
app.post('/api/outages/:id/upvote', voteLimiter, async (req, res) => {
  const { id } = req.params;
  const voterHash = hashIP(req);

  const outageResult = await db.execute({
    sql: 'SELECT * FROM outages WHERE id = ?',
    args: [id],
  });
  const outage = outageResult.rows[0];
  if (!outage) return res.status(404).json({ error: 'Outage not found' });
  if (new Date(outage.expires_at) < new Date()) {
    return res.status(410).json({ error: 'This outage report has expired' });
  }

  const voteCheck = await db.execute({
    sql: 'SELECT 1 FROM upvotes WHERE outage_id = ? AND voter_hash = ?',
    args: [id, voterHash],
  });
  if (voteCheck.rows.length > 0) {
    return res.status(409).json({ error: 'You have already confirmed this outage' });
  }

  await db.batch([
    { sql: 'UPDATE outages SET upvotes = upvotes + 1 WHERE id = ?', args: [id] },
    { sql: `INSERT INTO upvotes (outage_id, voter_hash, voted_at) VALUES (?, ?, datetime('now'))`, args: [id, voterHash] },
  ]);

  const updatedResult = await db.execute({
    sql: 'SELECT upvotes FROM outages WHERE id = ?',
    args: [id],
  });
  res.json({ success: true, upvotes: Number(updatedResult.rows[0].upvotes) });
});

// GET /api/weather — PAGASA proxy
app.get('/api/weather', async (req, res) => {
  try {
    const response = await fetch('https://tenday.pagasa.dost.gov.ph/api/v1/tenday/current', {
      headers: { 'User-Agent': 'PH-Power-Outage-Tracker/1.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`PAGASA API returned ${response.status}`);
    res.json(await response.json());
  } catch (err) {
    res.json({ error: 'Weather data temporarily unavailable', data: null });
  }
});

// Fallback: SPA index
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

module.exports = app;
