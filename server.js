// Local development entry point.
// On Vercel, api/index.js is used directly as a serverless function.
const app = require('./api/index');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PH Power Outage Tracker running at http://localhost:${PORT}`);
});
