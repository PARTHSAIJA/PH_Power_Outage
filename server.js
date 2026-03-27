const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const { stmts } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Rate limiting for report submission
const reportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many reports submitted. Please wait before reporting again.' }
});

const voteLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  message: { error: 'Too many votes. Please slow down.' }
});

// Helper: anonymize IP for rate-limiting/dedup without storing real IPs
function hashIP(req) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  return crypto.createHash('sha256').update(ip + process.env.HASH_SALT || 'ph-outage-salt-2024').digest('hex').slice(0, 16);
}

// Valid Philippine regions
const PH_REGIONS = new Set([
  'NCR', 'CAR', 'Region I', 'Region II', 'Region III', 'Region IV-A',
  'Region IV-B', 'Region V', 'Region VI', 'Region VII', 'Region VIII',
  'Region IX', 'Region X', 'Region XI', 'Region XII', 'Region XIII',
  'BARMM', 'Unknown'
]);

// Clean up expired outages every 10 minutes
setInterval(() => {
  try {
    const result = stmts.deleteExpired.run();
    if (result.changes > 0) {
      console.log(`Cleaned up ${result.changes} expired outage(s)`);
    }
  } catch (err) {
    console.error('Cleanup error:', err);
  }
}, 10 * 60 * 1000);

// ─── ROUTES ─────────────────────────────────────────────────────────────────

// GET /api/outages - Get all active outages
app.get('/api/outages', (req, res) => {
  try {
    const outages = stmts.getActiveOutages.all();
    res.json({ outages, count: outages.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch outages' });
  }
});

// GET /api/stats - Get outage statistics by region
app.get('/api/stats', (req, res) => {
  try {
    const regionStats = stmts.getStats.all();
    const total = stmts.getRecentCount.get();
    res.json({ byRegion: regionStats, total: total.count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// POST /api/outages - Submit a new outage report
app.post('/api/outages', reportLimiter, (req, res) => {
  const { lat, lng, region, province, city, barangay, description, type } = req.body;

  // Validation
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

  // Limit: max 5 reports per hour per IP
  const recentCount = stmts.checkReporterLimit.get(reporterHash);
  if (recentCount.count >= 5) {
    return res.status(429).json({ error: 'You have reported too many outages recently. Please wait.' });
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 6 * 60 * 60 * 1000); // 6 hours

  const outage = {
    id: uuidv4(),
    lat,
    lng,
    region,
    province: province || null,
    city: city || null,
    barangay: barangay || null,
    description: description ? description.trim().slice(0, 500) : null,
    type: type || 'unplanned',
    reported_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    reporter_hash: reporterHash
  };

  stmts.insertOutage.run(outage);

  res.status(201).json({
    success: true,
    outage: { ...outage, reporter_hash: undefined }
  });
});

// POST /api/outages/:id/upvote - Confirm/upvote an outage
app.post('/api/outages/:id/upvote', voteLimiter, (req, res) => {
  const { id } = req.params;
  const voterHash = hashIP(req);

  const outage = stmts.getOutageById.get(id);
  if (!outage) {
    return res.status(404).json({ error: 'Outage not found' });
  }

  // Check if expired
  if (new Date(outage.expires_at) < new Date()) {
    return res.status(410).json({ error: 'This outage report has expired' });
  }

  // Check if already voted
  const alreadyVoted = stmts.hasVoted.get(id, voterHash);
  if (alreadyVoted) {
    return res.status(409).json({ error: 'You have already confirmed this outage' });
  }

  stmts.upvoteOutage.run(id);
  stmts.insertVote.run(id, voterHash);

  const updated = stmts.getOutageById.get(id);
  res.json({ success: true, upvotes: updated.upvotes });
});

// GET /api/weather - Proxy PAGASA weather data to avoid CORS issues
app.get('/api/weather', async (req, res) => {
  try {
    const response = await fetch('https://tenday.pagasa.dost.gov.ph/api/v1/tenday/current', {
      headers: { 'User-Agent': 'PH-Power-Outage-Tracker/1.0' },
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error(`PAGASA API returned ${response.status}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    // Return empty on failure — weather is supplementary
    res.json({ error: 'Weather data temporarily unavailable', data: null });
  }
});

// Serve the SPA for any unmatched routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`PH Power Outage Tracker running at http://localhost:${PORT}`);
});
