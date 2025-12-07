/**
 * server.js
 * Simple Express server to aggregate GitHub contribution calendars using GitHub GraphQL API.
 *
 * Endpoints:
 * - GET /api/combined?users=donken,donken-lilly
 *    -> application/json: { start, end, total, counts: { "YYYY-MM-DD": number } }
 *
 * - GET /api/combined.svg?users=donken,donken-lilly
 *    -> image/svg+xml: combined contributions calendar SVG (now with month labels and weekday labels)
 *
 * Requirements:
 * - Set GITHUB_TOKEN environment variable (recommended to avoid strict rate limits; public data accessible without scopes)
 */

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
require('dotenv').config();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
if (!GITHUB_TOKEN) {
  console.warn('Warning: GITHUB_TOKEN not set. GitHub GraphQL requests will be rate limited.');
}

const GRAPHQL_URL = 'https://api.github.com/graphql';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

// Simple in-memory cache: key -> { ts, data }
const cache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 60s

const CONTRIBUTION_QUERY = `
query ($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays {
            date
            contributionCount
          }
        }
      }
    }
  }
}
`;

async function fetchUserCalendar(login) {
  const cacheKey = `user:${login}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && (now - cached.ts) < CACHE_TTL_MS) return cached.data;

  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: GITHUB_TOKEN ? `bearer ${GITHUB_TOKEN}` : '',
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'contrib-aggregator'
    },
    body: JSON.stringify({
      query: CONTRIBUTION_QUERY,
      variables: { login }
    })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}: ${txt}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`GitHub API errors: ${JSON.stringify(json.errors)}`);
  }

  const weeks = json.data.user.contributionsCollection.contributionCalendar.weeks;
  const map = new Map();
  for (const w of weeks) {
    for (const day of w.contributionDays) {
      map.set(day.date, day.contributionCount);
    }
  }

  cache.set(cacheKey, { ts: now, data: map });
  return map;
}

function mergeMaps(maps) {
  const merged = new Map();
  for (const m of maps) {
    for (const [date, count] of m.entries()) {
      merged.set(date, (merged.get(date) || 0) + count);
    }
  }
  return merged;
}

function mergedMapToPayload(merged) {
  const dates = Array.from(merged.keys()).sort();
  const start = dates[0] || null;
  const end = dates[dates.length - 1] || null;
  let total = 0;
  const counts = {};
  for (const [d, c] of Array.from(merged.entries())) {
    counts[d] = c;
    total += c;
  }
  return { start, end, total, counts };
}

/**
 * renderCalendarSVG - improved to include month labels (top) and weekday labels (left)
 */
function renderCalendarSVG(mergedPayload, usersLabel) {
  const { start, end, counts } = mergedPayload;
  if (!start || !end) return '<svg xmlns="http://www.w3.org/2000/svg"></svg>';

  const dateToCount = counts;
  const parseDate = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  };

  const startDate = parseDate(start);
  // Align calendarStart to previous Sunday (GitHub weeks start Sunday)
  const startDow = startDate.getUTCDay();
  const calendarStart = new Date(startDate);
  calendarStart.setUTCDate(startDate.getUTCDate() - startDow);
  calendarStart.setUTCHours(0,0,0,0);

  const lastDate = parseDate(end);
  const msPerDay = 24 * 60 * 60 * 1000;
  const totalDays = Math.round((lastDate - calendarStart) / msPerDay) + 1;
  const weeks = Math.ceil(totalDays / 7);

  const rectSize = 12;
  const gap = 4;
  const paddingTop = 22; // room for month labels
  const paddingLeft = 36; // room for weekday labels
  const padding = 8;
  const width = paddingLeft + padding + weeks * (rectSize + gap);
  const height = paddingTop + padding + 7 * (rectSize + gap);

  // compute palette and thresholds
  const vals = Object.values(dateToCount);
  const maxCount = Math.max(...vals, 1);
  const breaks = [
    Math.max(0, 0),
    Math.max(1, Math.floor(maxCount * 0.25)),
    Math.max(1, Math.floor(maxCount * 0.5)),
    Math.max(1, Math.floor(maxCount * 0.75))
  ];
  const palette = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'];

  function colorForCount(count) {
    for (let i = 0; i < breaks.length; i++) {
      if (count <= breaks[i]) return palette[i];
    }
    return palette[palette.length - 1];
  }

  // Build month labels: find the first day of each month within the calendar range
  const monthPositions = {}; // monthKey -> weekIndex (first occurrence)
  for (let i = 0; i <= totalDays - 1; i++) {
    const d = new Date(calendarStart.getTime() + i * msPerDay);
    const iso = d.toISOString().slice(0,10);
    const [y, m] = iso.split('-');
    const monthKey = `${y}-${m}`; // YYYY-MM
    if (!(monthKey in monthPositions)) {
      // compute week index for this date
      const weekIndex = Math.floor(i / 7);
      monthPositions[monthKey] = weekIndex;
    }
  }

  // Prepare weekday label positions for Mon/Wed/Fri (GitHub shows a few weekday labels)
  const weekdayLabels = [
    { dow: 1, label: 'Mon' },
    { dow: 3, label: 'Wed' },
    { dow: 5, label: 'Fri' }
  ];

  // Build rects and month label SVG fragments
  let rects = '';
  for (let i = 0; i <= totalDays - 1; i++) {
    const d = new Date(calendarStart.getTime() + i * msPerDay);
    const iso = d.toISOString().slice(0, 10);
    const count = dateToCount[iso] || 0;
    const dayOfWeek = d.getUTCDay();
    const weekIndex = Math.floor(i / 7);
    const x = paddingLeft + padding + weekIndex * (rectSize + gap);
    const y = paddingTop + padding + dayOfWeek * (rectSize + gap);
    const fill = colorForCount(count);
    const title = `${count} contributions on ${iso}`;
    rects += `<rect x="${x}" y="${y}" width="${rectSize}" height="${rectSize}" rx="2" ry="2" fill="${fill}" stroke="#e6e6e6" stroke-width="0.5"><title>${title}</title></rect>\n`;
  }

  // Month label SVG
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  // sort monthKeys chronologically
  const monthKeys = Object.keys(monthPositions).sort();
  let monthLabelsSvg = '';
  for (const mk of monthKeys) {
    const [y, m] = mk.split('-');
    const monthIndex = Number(m) - 1;
    const label = monthNames[monthIndex];
    const weekIndex = monthPositions[mk];
    const x = paddingLeft + padding + weekIndex * (rectSize + gap);
    // Place month label slightly left of the column so it doesn't overlap the square
    const textX = x;
    const textY = Math.max(12, paddingTop - 6);
    monthLabelsSvg += `<text x="${textX}" y="${textY}" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="#6a737d">${label}</text>\n`;
  }

  // Weekday labels SVG (left side)
  let weekdayLabelsSvg = '';
  for (const wl of weekdayLabels) {
    const y = paddingTop + padding + wl.dow * (rectSize + gap) + rectSize / 2 + 4; // vertical centering tweak
    const x = paddingLeft - 6; // place to the left of the grid
    weekdayLabelsSvg += `<text x="${x}" y="${y}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="11" fill="#6a737d">${wl.label}</text>\n`;
  }

  // Combine into final SVG
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Combined contributions calendar for ${usersLabel}">
  <rect width="100%" height="100%" fill="transparent"/>
  <!-- Month labels -->
  ${monthLabelsSvg}
  <!-- Weekday labels -->
  ${weekdayLabelsSvg}
  <!-- Contribution squares -->
  ${rects}
</svg>`;

  return svg;
}

function parseUsersParam(req) {
  const raw = req.query.users || '';
  const users = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (users.length === 0) throw new Error('Missing users parameter. Example: ?users=donken,donken-lilly');
  if (users.length > 10) throw new Error('Too many users requested (limit 10).');
  return users;
}

async function aggregateUsers(users) {
  const maps = await Promise.all(users.map(fetchUserCalendar));
  const merged = mergeMaps(maps);
  const payload = mergedMapToPayload(merged);
  return payload;
}

// JSON endpoint
app.get('/api/combined', async (req, res) => {
  try {
    const users = parseUsersParam(req);
    const cacheKey = `combined:${users.join(',')}`;
    const now = Date.now();
    const cached = cache.get(cacheKey);
    if (cached && (now - cached.ts) < CACHE_TTL_MS) {
      return res.json(cached.data);
    }

    const payload = await aggregateUsers(users);
    cache.set(cacheKey, { ts: now, data: payload });
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: String(err.message || err) });
  }
});

// SVG endpoint (with improved labels)
app.get('/api/combined.svg', async (req, res) => {
  try {
    const users = parseUsersParam(req);
    const cacheKey = `combinedsvg:${users.join(',')}`;
    const now = Date.now();
    const cached = cache.get(cacheKey);
    if (cached && (now - cached.ts) < CACHE_TTL_MS) {
      res.setHeader('Content-Type', 'image/svg+xml');
      return res.send(cached.data);
    }

    const payload = await aggregateUsers(users);
    const svg = renderCalendarSVG(payload, users.join(' and '));
    cache.set(cacheKey, { ts: now, data: svg });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch (err) {
    console.error(err);
    res.status(400).send(`<svg xmlns="http://www.w3.org/2000/svg"><text x="10" y="20" fill="red">Error: ${String(err.message || err)}</text></svg>`);
  }
});

app.get('/', (req, res) => {
  res.send('GitHub contributions aggregator. Use /api/combined?users=user1,user2 or /api/combined.svg?users=...');
});

app.listen(PORT, () => {
  console.log(`Contributor aggregator server listening on http://localhost:${PORT}`);
});
