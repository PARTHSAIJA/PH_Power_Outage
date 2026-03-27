// Local development entry point.
// On Vercel, api/index.js is used directly as a serverless function.
const app = require('./api/index');
const { runScrapers } = require('./scrapers/index');

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`PH Power Outage Tracker running at http://localhost:${PORT}`);

  // Run scrapers on startup, then every 30 minutes
  try {
    await runScrapers();
  } catch (err) {
    console.warn('Initial scrape failed:', err.message);
  }
  setInterval(async () => {
    try { await runScrapers(); } catch (err) { console.warn('Scrape error:', err.message); }
  }, 30 * 60 * 1000);
});
