/**
 * Brave Search API wrapper — used by Claude to search instead of WebSearch
 * Avoids triggering paid tier upgrades on Google Vertex AI
 */

const https = require('https');

const BRAVE_KEY = process.env.BRAVE_SEARCH_API_KEY || '';

/**
 * Search using Brave API (free tier, no paid tier auto-upgrade)
 * @param {string} query - Search query
 * @param {number} limit - Number of results (default 10)
 * @returns {Promise<Array>} Search results with title, description, url
 */
async function braveSearch(query, limit = 10) {
  if (!BRAVE_KEY) {
    return {
      error: 'Brave Search API key not configured',
      query,
    };
  }

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.search.brave.com',
      path: `/res/v1/web/search?q=${encodeURIComponent(query)}&count=${Math.min(limit, 20)}`,
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': BRAVE_KEY,
      },
    };

    https.get(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const results = (json.web || [])
            .slice(0, limit)
            .map((r) => ({
              title: r.title,
              description: r.description,
              url: r.url,
              snippet: r.description,
            }));

          resolve({
            query,
            results,
            count: results.length,
          });
        } catch (e) {
          resolve({
            error: e.message,
            query,
          });
        }
      });
    }).on('error', (err) => {
      resolve({
        error: err.message,
        query,
      });
    });
  });
}

module.exports = { braveSearch };
