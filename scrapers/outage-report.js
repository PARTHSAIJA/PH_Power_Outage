/**
 * Outage.Report Philippines
 * Scrapes real-time outage complaint counts from:
 * https://outage.report/ph
 *
 * This site aggregates crowd-sourced outage reports from social media.
 * We extract the current provider complaint counts and convert high-volume
 * spikes into map markers (a spike = likely active outage).
 */
const cheerio = require('cheerio');
const { fetchHtml, AREA_CENTERS, shortenText } = require('./utils');

const BASE_URL = 'https://outage.report';
const PH_URL   = `${BASE_URL}/ph`;

// Known PH providers on outage.report and their approximate areas
const PROVIDER_MAP = {
  meralco:  { ...AREA_CENTERS.meralco, province: 'Metro Manila', label: 'Meralco' },
  pldt:     { lat: 14.5995, lng: 120.9842, region: 'NCR', province: 'Metro Manila', label: 'PLDT' },
  globe:    { lat: 14.5995, lng: 120.9842, region: 'NCR', province: 'Metro Manila', label: 'Globe' },
  smart:    { lat: 14.5995, lng: 120.9842, region: 'NCR', province: 'Metro Manila', label: 'Smart' },
  veco:     { ...AREA_CENTERS.veco,    province: 'Cebu', label: 'VECO' },
  converge: { lat: 14.5995, lng: 120.9842, region: 'NCR', province: 'Metro Manila', label: 'Converge' },
};

// Threshold: minimum reports in last hour to show as a map marker
const SPIKE_THRESHOLD = 5;

async function scrape() {
  const html = await fetchHtml(PH_URL, { Referer: BASE_URL });
  const $ = cheerio.load(html);
  const results = [];

  // outage.report lists providers with current report counts
  // Try to find provider rows/cards
  $('a[href*="/ph/"], .provider, .company, .outage-item, tr').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().trim();

    // Extract report count — usually a number like "47 reports"
    const countMatch = text.match(/(\d+)\s*(?:reports?|outages?|incidents?)/i);
    const count = countMatch ? parseInt(countMatch[1], 10) : 0;

    // Match to known provider
    const providerKey = Object.keys(PROVIDER_MAP).find(key => {
      const label = PROVIDER_MAP[key].label.toLowerCase();
      return text.toLowerCase().includes(label) || href.toLowerCase().includes(key);
    });

    if (!providerKey || count < SPIKE_THRESHOLD) return;

    const provider = PROVIDER_MAP[providerKey];
    const providerUrl = href.startsWith('http') ? href : BASE_URL + href;

    results.push({
      lat: provider.lat + (Math.random() - 0.5) * 0.05,
      lng: provider.lng + (Math.random() - 0.5) * 0.05,
      region: provider.region,
      province: provider.province,
      city: null,
      barangay: null,
      description: `${count} outage reports in the last hour for ${provider.label} (via outage.report)`,
      type: 'unplanned',
      source: 'outage.report',
      source_url: providerUrl,
      affected_areas: `${provider.label} service area — ${count} reports`,
    });
  });

  // If structured parsing failed, try a JSON data endpoint
  if (results.length === 0) {
    return await scrapeJson();
  }

  return results;
}

async function scrapeJson() {
  // outage.report sometimes exposes chart data as JSON
  const endpoints = [
    `${BASE_URL}/api/report/ph`,
    `${BASE_URL}/api/outage/ph`,
    `${BASE_URL}/data/ph.json`,
  ];

  for (const url of endpoints) {
    try {
      const res = await fetchHtml(url);
      const data = typeof res === 'string' ? JSON.parse(res) : res;
      if (Array.isArray(data) && data.length > 0) {
        return data
          .filter(item => item.count >= SPIKE_THRESHOLD)
          .map(item => ({
            lat: AREA_CENTERS.meralco.lat,
            lng: AREA_CENTERS.meralco.lng,
            region: 'NCR',
            province: 'Metro Manila',
            city: null,
            barangay: null,
            description: `${item.count} reports: ${item.provider || item.name || 'Unknown provider'}`,
            type: 'unplanned',
            source: 'outage.report',
            source_url: PH_URL,
            affected_areas: null,
          }));
      }
    } catch {
      // Try next endpoint
    }
  }

  return []; // All endpoints failed
}

module.exports = { scrape, name: 'Outage.Report', url: PH_URL };
