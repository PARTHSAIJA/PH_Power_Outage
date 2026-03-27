/**
 * Meralco — Metro Manila & nearby provinces
 * Two sources tried in order:
 * 1. company.meralco.com.ph/news-and-advisories (planned interruptions)
 * 2. meralco.com.ph RSS feed
 */
const cheerio = require('cheerio');
const { fetchHtml, AREA_CENTERS, shortenText } = require('./utils');

const NEWS_URL = 'https://company.meralco.com.ph/news-and-advisories';
const RSS_URL  = 'https://company.meralco.com.ph/rss.xml';
const BASE_URL = 'https://company.meralco.com.ph';

// NCR city/municipality list for coordinate jitter
const NCR_CITIES = [
  { city: 'Manila',          lat: 14.5995, lng: 120.9842 },
  { city: 'Quezon City',     lat: 14.6760, lng: 121.0437 },
  { city: 'Caloocan',        lat: 14.6492, lng: 120.9673 },
  { city: 'Makati',          lat: 14.5547, lng: 121.0244 },
  { city: 'Pasig',           lat: 14.5764, lng: 121.0851 },
  { city: 'Taguig',          lat: 14.5243, lng: 121.0792 },
  { city: 'Marikina',        lat: 14.6507, lng: 121.1029 },
  { city: 'Parañaque',       lat: 14.4793, lng: 121.0198 },
  { city: 'Las Piñas',       lat: 14.4453, lng: 120.9929 },
  { city: 'Muntinlupa',      lat: 14.4080, lng: 121.0415 },
  { city: 'Mandaluyong',     lat: 14.5794, lng: 121.0359 },
  { city: 'San Juan',        lat: 14.6019, lng: 121.0355 },
  { city: 'Pasay',           lat: 14.5378, lng: 120.9984 },
  { city: 'Navotas',         lat: 14.6678, lng: 120.9427 },
  { city: 'Malabon',         lat: 14.6627, lng: 120.9570 },
  { city: 'Valenzuela',      lat: 14.7011, lng: 120.9830 },
  { city: 'Pateros',         lat: 14.5454, lng: 121.0684 },
];

async function scrape() {
  // Try RSS first (lighter, more structured)
  try {
    return await scrapeRss();
  } catch {
    // Fall through to HTML scraping
  }
  return await scrapeHtml();
}

async function scrapeRss() {
  const xml = await fetchHtml(RSS_URL);
  const $ = cheerio.load(xml, { xmlMode: true });
  const results = [];

  $('item').slice(0, 10).each((_, el) => {
    const title = $(el).find('title').text().trim();
    const desc  = $(el).find('description').text().replace(/<[^>]+>/g, ' ').trim();
    const link  = $(el).find('link').text().trim();

    if (!title) return;
    if (!/interruption|outage|brownout|maintenance|advisory|notice/i.test(title + desc)) return;

    results.push(buildOutage(title, desc, link || NEWS_URL));
  });

  if (results.length === 0) throw new Error('No relevant RSS items');
  return results;
}

async function scrapeHtml() {
  const html = await fetchHtml(NEWS_URL, { Referer: BASE_URL });
  const $ = cheerio.load(html);
  const results = [];

  const posts = $('article, .post, .news-item, .advisory, .card, .entry').toArray();

  for (const post of posts.slice(0, 12)) {
    const el = $(post);
    const title = el.find('h1,h2,h3,h4,.title,.entry-title').first().text().trim()
      || el.find('a').first().text().trim();

    if (!title || title.length < 10) continue;
    if (!/interruption|outage|brownout|maintenance|advisory|planned/i.test(title)) continue;

    const content = el.find('p,.content,.excerpt').first().text().trim();
    const link = el.find('a').first().attr('href');
    const fullLink = link ? (link.startsWith('http') ? link : BASE_URL + link) : NEWS_URL;

    results.push(buildOutage(title, content, fullLink));
  }

  return results;
}

function buildOutage(title, content, sourceUrl) {
  const combined = title + ' ' + (content || '');
  const isPlanned = /scheduled|planned|maintenance|notice/i.test(combined);

  // Try to match a known NCR city in the text
  let cityEntry = NCR_CITIES.find(c => new RegExp(c.city, 'i').test(combined));
  if (!cityEntry) cityEntry = NCR_CITIES[Math.floor(Math.random() * NCR_CITIES.length)];

  const barangayMatch = combined.match(/(?:brgy\.?|barangay)\s+([\w\s]+?)(?:,|\.|;|\n|$)/i);
  const barangay = barangayMatch ? barangayMatch[1].trim().slice(0, 80) : null;

  return {
    lat: cityEntry.lat + (Math.random() - 0.5) * 0.015,
    lng: cityEntry.lng + (Math.random() - 0.5) * 0.015,
    region: 'NCR',
    province: 'Metro Manila',
    city: cityEntry.city,
    barangay,
    description: shortenText([title, content ? shortenText(content, 300) : null].filter(Boolean).join(' — '), 500),
    type: isPlanned ? 'planned' : 'unplanned',
    source: 'meralco',
    source_url: sourceUrl,
    affected_areas: content ? shortenText(content, 300) : null,
  };
}

module.exports = { scrape, name: 'Meralco', url: NEWS_URL };
