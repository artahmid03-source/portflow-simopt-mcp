const { chromium } = require('playwright');
(async () => { const b = await chromium.launch(), p = await b.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
await p.goto('file://' + __dirname + '/dist/test_full.html'); await p.waitForSelector('.y3-box'); await p.waitForTimeout(2500);
const y = await p.$('.y3-stage'); await y.scrollIntoViewIfNeeded(); await p.waitForTimeout(800);
await (await p.$('.pf-grid > section:nth-of-type(5)')).screenshot({ path: 'shots/06_yard.png' });
await p.click('.pf-scrub button'); await p.waitForTimeout(3500); await p.click('.pf-scrub button');
await (await p.$('.pf-grid > section:nth-of-type(1)')).screenshot({ path: 'shots/07_traffic.png' });
await b.close(); })();
