/**
 * DLPC (Davao Light and Power Company) — Davao City
 * Scrapes service interruptions from:
 * https://www.davaolight.com/index.php/pages/service-interruption
 */
const cheerio = require('cheerio');
const { fetchHtml, AREA_CENTERS, shortenText } = require('./utils');

const BASE_URL = 'https://www.davaolight.com';
const INTERRUPTION_URL = `${BASE_URL}/index.php/pages/service-interruption`;

async function scrape() {
  const html = await fetchHtml(INTERRUPTION_URL, { Referer: BASE_URL });
  const $ = cheerio.load(html);
  const results = [];

  // Try common CMS patterns
  const items = $('article, .interruption-item, .post, .entry, .news-item, .item, tr').toArray();

  if (items.length === 0) {
    // Fallback: grab all meaningful paragraph text
    $('p, li').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length < 20) return;
      if (!/interruption|outage|brownout|maintenance|power/i.test(text)) return;
      results.push(buildOutage(text, null, INTERRUPTION_URL));
    });
    return results.slice(0, 8);
  }

  for (const item of items.slice(0, 10)) {
    const el = $(item);
    const title = el.find('h1,h2,h3,h4,.title,td:first-child').first().text().trim()
      || el.find('a').first().text().trim()
      || el.text().trim().slice(0, 100);

    if (!title || title.length < 10) continue;
    if (!/interruption|outage|brownout|maintenance|power|area/i.test(title)) continue;

    const content = el.find('p, .content, td:last-child').first().text().trim();
    const link = el.find('a').first().attr('href');
    const fullLink = link ? (link.startsWith('http') ? link : BASE_URL + link) : INTERRUPTION_URL;

    results.push(buildOutage(title, content, fullLink));
  }

  return results;
}

function buildOutage(title, content, sourceUrl) {
  const isPlanned = /scheduled|planned|maintenance|notice/i.test(title + (content || ''));

  // Try to extract barangay from text
  const barangayMatch = (title + ' ' + (content || '')).match(/barangay\s+([\w\s]+?)(?:,|\.|;|and|\n|$)/i);
  const barangay = barangayMatch ? barangayMatch[1].trim() : null;

  const desc = [title, content ? shortenText(content, 300) : null]
    .filter(Boolean).join(' — ');

  return {
    lat: AREA_CENTERS.dlpc.lat + (Math.random() - 0.5) * 0.08,
    lng: AREA_CENTERS.dlpc.lng + (Math.random() - 0.5) * 0.08,
    region: AREA_CENTERS.dlpc.region,
    province: 'Davao del Sur',
    city: 'Davao City',
    barangay,
    description: shortenText(desc, 500),
    type: isPlanned ? 'planned' : 'unplanned',
    source: 'dlpc',
    source_url: sourceUrl,
    affected_areas: content ? shortenText(content, 300) : null,
  };
}

module.exports = { scrape, name: 'DLPC', url: INTERRUPTION_URL };
