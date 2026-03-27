/**
 * VECO (Visayan Electric Company) — Cebu
 * Scrapes service advisories from:
 * https://www.visayanelectric.com/customer-services/service-advisory
 */
const cheerio = require('cheerio');
const { fetchHtml, AREA_CENTERS, shortenText } = require('./utils');

const BASE_URL = 'https://www.visayanelectric.com';
const ADVISORY_URL = `${BASE_URL}/customer-services/service-advisory`;

async function scrape() {
  const html = await fetchHtml(ADVISORY_URL, { Referer: BASE_URL });
  const $ = cheerio.load(html);
  const results = [];

  // VECO posts advisories as article/post cards. Try multiple selector patterns.
  const posts = $('article, .post, .entry-item, .advisory-item, .card, .news-item').toArray();

  // Fallback: look for any link containing "service-interruption"
  if (posts.length === 0) {
    $('a[href*="service-interruption"], a[href*="advisory"]').each((_, el) => {
      const href = $(el).attr('href');
      const title = $(el).text().trim();
      if (!href || !title || title.length < 5) return;
      results.push(buildOutage(title, null, href.startsWith('http') ? href : BASE_URL + href));
    });
    return results;
  }

  for (const post of posts.slice(0, 10)) {
    const el = $(post);
    const title = el.find('h1, h2, h3, h4, .title, .entry-title').first().text().trim()
      || el.find('a').first().text().trim();
    if (!title || title.length < 5) continue;

    // Skip if not interruption-related
    if (!/interruption|outage|brownout|maintenance|advisory/i.test(title)) continue;

    const content = el.find('p, .content, .entry-content, .excerpt').first().text().trim();
    const link = el.find('a').first().attr('href');
    const fullLink = link ? (link.startsWith('http') ? link : BASE_URL + link) : ADVISORY_URL;

    results.push(buildOutage(title, content, fullLink));
  }

  return results;
}

function buildOutage(title, content, sourceUrl) {
  const isPlanned = /scheduled|planned|maintenance|notice/i.test(title + (content || ''));
  const desc = [title, content ? shortenText(content, 300) : null]
    .filter(Boolean).join(' — ');

  return {
    lat: AREA_CENTERS.veco.lat + (Math.random() - 0.5) * 0.1, // slight randomness within Cebu
    lng: AREA_CENTERS.veco.lng + (Math.random() - 0.5) * 0.1,
    region: AREA_CENTERS.veco.region,
    province: 'Cebu',
    city: 'Cebu City',
    barangay: null,
    description: shortenText(desc, 500),
    type: isPlanned ? 'planned' : 'unplanned',
    source: 'veco',
    source_url: sourceUrl,
    affected_areas: content ? shortenText(content, 300) : null,
  };
}

module.exports = { scrape, name: 'VECO', url: ADVISORY_URL };
