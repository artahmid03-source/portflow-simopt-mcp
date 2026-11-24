// Browser test of the public tower pages (docs/tower/*.html) with the live feed mocked.
//   node test_towers.cjs <hamburg tower.json>
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const [hamFile] = process.argv.slice(2);
const docs = path.join(__dirname, '..', 'docs', 'tower');
const workers = [];
const fmt = (x, d) => Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

async function open(browser, file, feed) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('worker', (w) => workers.push(w.url()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_|net::/.test(m.text())) errors.push(`console: ${m.text()}`); });
  await page.route(/tile\.openstreetmap|openseamap|fonts\.g/, (r) => r.abort());
  await page.route(/raw\.githubusercontent\.com/, (r) => (feed ? r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(feed) }) : r.fulfill({ status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'no' })));
  await page.goto('file://' + path.join(docs, file) + '?api=off');   // the real API is tested in test_api.cjs
  await page.waitForSelector('.pf-kpi', { timeout: 20000 });
  await page.waitForTimeout(1300);
  return { page, errors };
}
const kpis = (page) => page.$$eval('.pf-kpi .v', (els) => els.map((e) => e.textContent));
const send = async (page, text) => {
  await page.fill('.pf-in input', text); await page.click('.pf-in button');
  await page.waitForFunction(() => !document.querySelector('.pf-in input').disabled, null, { timeout: 60000 });
  await page.waitForTimeout(1300);
};

(async () => {
  const browser = await chromium.launch();
  let n = 0;
  // Hamburg: live feed, real map, terminal bands, a terminal crane outage re-plans to the CP-SAT reference
  {
    const d = JSON.parse(fs.readFileSync(hamFile, 'utf8'));
    const { page, errors } = await open(browser, 'hamburg.html', hamFile);
    assert.ok((await page.textContent('.pf-lamps')).includes('LIVE DATA'), 'live lamp'); n++;
    assert.strictEqual((await kpis(page))[0], `${fmt(d.optimised.kpis.avg_turnaround_days, 2)}days`, 'turnaround tile'); n++;
    assert.strictEqual(await page.$$eval('.pf-gbar', (e) => e.length), d.optimised.schedule.length, 'one Gantt bar per ship'); n++;
    assert.ok(await page.$('.pf-map.leaflet-container'), 'Leaflet map'); n++;
    const mk = await page.$$eval('.pf-mk', (e) => e.length);
    assert.ok(mk >= d.live.fixed_occupants.length && mk <= d.optimised.schedule.length + d.live.fixed_occupants.length, `ship markers ${mk}`); n++;
    for (const q of Object.keys(d.live.quays)) assert.ok((await page.textContent('.pf-scroll')).includes(q), `quay band ${q}`);
    n++;
    const ref = d.reference_cases.find((c) => c.case === '6 quay cranes out 48 h');
    await send(page, 'Take 6 quay cranes at Burchardkai offline for 48 hours');
    assert.deepStrictEqual(await page.$$eval('.pf-chip.act', (e) => e.map((x) => x.textContent)), ['6 CTB STS out h0–48'], 'terminal outage chip'); n++;
    assert.strictEqual((await kpis(page))[0], `${fmt(ref.kpis.avg_turnaround_days, 2)}days`, 'outage re-plan matches CP-SAT'); n++;
    assert.ok((await page.textContent('body')).includes('Plan against reality'), 'plan-against-reality panel'); n++;
    assert.ok((await page.textContent('.pf-kpis')).includes('Cost of the queue'), 'cost tile'); n++;
    assert.ok(workers.length >= 1, 'the re-plan ran in a Web Worker'); n++;
    await page.click('.pf-btn:has-text("Play")'); await page.waitForTimeout(1500);
    await page.click('.pf-btn:has-text("Terminals")'); await page.waitForTimeout(900);
    assert.deepStrictEqual(errors, [], 'no errors on the Hamburg page'); n++;
    await page.close();
  }
  // Hamburg: feed missing -> the plan embedded in the page, with a banner and a SAVED PLAN lamp
  {
    const { page, errors } = await open(browser, 'hamburg.html', null);
    assert.ok((await page.textContent('.pf-banner')).includes('could not be loaded'), 'fallback banner'); n++;
    assert.ok((await page.textContent('.pf-lamps')).includes('SAVED PLAN'), 'saved-plan lamp, not LIVE'); n++;
    assert.ok((await page.$$eval('.pf-mk', (e) => e.length)) >= 5, 'saved plan ships on the real map'); n++;
    assert.deepStrictEqual(errors, [], 'no errors on fallback'); n++;
    await page.close();
  }
  // Hamburg: the live run found no ship -> the last plan that had ships, or the embedded plan, with an information banner
  for (const lastOk of [true, false]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await page.route(/tile\.openstreetmap|openseamap|fonts\.g/, (r) => r.abort());
    const empty = JSON.stringify({ status: 'no_queue', site_kind: 'hamburg', reason: 'no container ship declaring Hamburg', generated_utc: '2026-11-22T03:28:10+00:00', live: {} });
    await page.route(/raw\.githubusercontent\.com/, (r) => {
      const u = r.request().url(), h = { 'access-control-allow-origin': '*' };
      if (/tower_last_ok\.json/.test(u)) return lastOk ? r.fulfill({ status: 200, contentType: 'application/json', headers: h, body: fs.readFileSync(hamFile) }) : r.fulfill({ status: 404, headers: h, body: 'no' });
      return r.fulfill({ status: 200, contentType: 'application/json', headers: h, body: empty });
    });
    await page.goto('file://' + path.join(docs, 'hamburg.html') + '?api=off');
    await page.waitForSelector('.pf-banner', { timeout: 20000 }); await page.waitForTimeout(800);
    const banner = await page.textContent('.pf-banner'), cls = await page.getAttribute('.pf-banner', 'class');
    assert.ok(/ok/.test(cls), 'an empty queue is shown as information, not as an error'); n++;
    if (lastOk) { assert.ok(banner.includes('Showing the last live plan'), `last good plan banner: ${banner}`); n++; assert.ok((await page.textContent('.pf-lamps')).includes('LIVE DATA'), 'last plan is live data'); n++; }
    else { assert.ok(banner.includes('Showing the plan for the queue read'), `embedded plan banner: ${banner}`); n++; assert.ok((await page.textContent('.pf-lamps')).includes('SAVED PLAN'), 'embedded plan lamp'); n++; }
    assert.ok((await page.$$eval('.pf-mk', (e) => e.length)) >= 5, 'ships on the map'); n++;
    assert.deepStrictEqual(errors, [], 'no page errors'); n++;
    await page.close();
  }
  // the retired Chattogram tower is gone from the public pages
  assert.ok(!fs.existsSync(path.join(docs, 'chattogram.html')), 'no chattogram.html'); n++;
  // the pipeline health lamp reads status.json from the data branch
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route(/tile\.openstreetmap|openseamap|fonts\.g/, (r) => r.abort());
    const status = { checked_utc: '2026-11-24T08:00:00+00:00', overall: 'warn', checks: [{ name: 'collector', state: 'ok', detail: 'fine' }, { name: 'port_list', state: 'warn', detail: 'list is 9 h old' }] };
    await page.route(/raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: /status\.json/.test(r.request().url()) ? JSON.stringify(status) : fs.readFileSync(hamFile) }));
    await page.goto('file://' + path.join(docs, 'hamburg.html') + '?api=off');
    await page.waitForSelector('.pf-kpi', { timeout: 20000 }); await page.waitForTimeout(1200);
    assert.ok((await page.textContent('.pf-lamps')).includes('PIPELINE: 1 NOTICE'), 'pipeline health lamp'); n++;
    assert.ok((await page.getAttribute('.pf-lamp[title*="port_list"]', 'title')).includes('9 h old'), 'lamp lists the notice'); n++;
    await page.close();
  }
  await browser.close();
  console.log(`OK: tower pages passed (${n} checks)`);
})().catch((e) => { console.error(e); process.exit(1); });
