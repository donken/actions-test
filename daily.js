// daily.js
const fs = require('fs');
const path = require('path');
const { aggregateUsers, renderCalendarSVG } = require('./server'); // reuse your functions

async function main() {
  const users = ['donken', 'donken-lilly']; // hardcode or read from env
  const payload = await aggregateUsers(users);
  const svg = renderCalendarSVG(payload, users.join(' and '));

  const outPath = path.join(__dirname, 'combined.svg');
  fs.writeFileSync(outPath, svg, 'utf8');
  console.log(`SVG updated at ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
