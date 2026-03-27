const axios = require('axios');

// Realistic browser headers to avoid bot detection
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,fil;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Upgrade-Insecure-Requests': '1',
};

async function fetchHtml(url, extraHeaders = {}) {
  const response = await axios.get(url, {
    headers: { ...BROWSER_HEADERS, ...extraHeaders },
    timeout: 15000,
    maxRedirects: 5,
  });
  return response.data;
}

// Simple rate-limited Nominatim geocoder (1 req/sec max per OSM policy)
let lastGeocode = 0;
async function geocode(query) {
  const now = Date.now();
  const wait = 1100 - (now - lastGeocode);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGeocode = Date.now();

  try {
    const res = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { q: `${query}, Philippines`, format: 'json', limit: 1 },
      headers: { 'User-Agent': 'PH-Power-Outage-Tracker/1.0 (contact: dev@example.com)' },
      timeout: 5000,
    });
    if (res.data.length > 0) {
      return { lat: parseFloat(res.data[0].lat), lng: parseFloat(res.data[0].lon) };
    }
  } catch {
    // Geocoding is best-effort; fall back to area center
  }
  return null;
}

// Default coordinates for each utility's service area
const AREA_CENTERS = {
  meralco: { lat: 14.5995, lng: 120.9842, region: 'NCR' },
  veco:    { lat: 10.3157, lng: 123.8854, region: 'Region VII' },
  dlpc:    { lat: 7.0731,  lng: 125.6128, region: 'Region XI' },
  ngcp:    { lat: 12.5,    lng: 122.0,    region: 'NCR' },
};

// Parse a Philippine date string to ISO — handles many formats
function parsePhDate(str) {
  if (!str) return null;
  const cleaned = str.replace(/\s+/g, ' ').trim();
  const d = new Date(cleaned);
  if (!isNaN(d.getTime())) return d.toISOString();
  return null;
}

// Extract a reasonable short title from a long advisory text
function shortenText(text, max = 200) {
  if (!text) return null;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? cleaned.slice(0, max) + '…' : cleaned;
}

module.exports = { fetchHtml, geocode, AREA_CENTERS, parsePhDate, shortenText };
