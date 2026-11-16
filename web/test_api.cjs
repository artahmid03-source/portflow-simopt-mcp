// The tower page re-plans through the server CP-SAT API when one is configured, and falls back to the browser when it is not.
//   node test_api.cjs <hamburg tower.json>      (starts api/app.py on a local port with the fixture as its data)
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const hamFile = path.resolve(process.argv[2]);
const PORT = 8765, API = `http://localhost:${PORT}`;
const docs = path.join(__dirname, '..', 'docs', 'tower');

(async () => {
  const fixtures = path.dirname(hamFile);
  const srv = spawn(process.env.PYTHON || 'python3', [path.join(__dirname, '..', 'api', 'app.py')], { env: { ...process.env, PORT: String(PORT), PORTFLOW_DATA_URL: `file://${fixtures}/{site}_tower.json`, PORTFLOW_CPSAT_WORKERS: '2' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let n = 0;
  try {
    for (let i = 0; i < 60; i++) { try { const r = await fetch(`${API}/health`); if (r.ok) break; } catch (e) { /* not up yet */ } await new Promise((r) => setTimeout(r, 500)); }
    const h = await (await fetch(`${API}/health`)).json(); assert.ok(h.ok, 'health'); n++;
    const bad = await fetch(`${API}/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ site: 'nowhere' }) });
    assert.strictEqual(bad.status, 400, 'unknown site is rejected'); n++;
    const d = JSON.parse(fs.readFileSync(hamFile, 'utf8'));
    const browser = await chromium.launch();
    for (const [q, expectServer] of [[`?api=${API}`, true], ['?api=off', false]]) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.route(/tile\.openstreetmap|openseamap|fonts\.g/, (r) => r.abort());
      await page.route(/raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(hamFile) }));
      await page.goto('file://' + path.join(docs, 'hamburg.html') + q);
      await page.waitForSelector('.pf-kpi', { timeout: 20000 });
      await page.fill('.pf-in input', 'Take 6 quay cranes at Burchardkai offline for 48 hours'); await page.click('.pf-in button');
      await page.waitForFunction(() => !document.querySelector('.pf-in input').disabled, null, { timeout: 120000 });
      await page.waitForTimeout(1300);
      const lamps = await page.textContent('.pf-lamps'), body = await page.textContent('body');
      if (process.env.DEBUG_API) console.log(lamps, body.match(/server CP-SAT[^\n]{0,160}/g));
      if (expectServer) {
        assert.ok(lamps.includes('SERVER CP-SAT RE-PLAN'), 'plan lamp names the server engine'); n++;
        assert.ok(body.includes('server CP-SAT answered'), 'log shows the server answer'); n++;
        const ref = d.reference_cases.find((c) => c.case === '6 quay cranes out 48 h');
        const tile = await page.$eval('.pf-kpi .v', (e) => e.textContent);
        assert.strictEqual(tile, `${Number(ref.kpis.avg_turnaround_days).toFixed(2)}days`, 'server re-plan equals the CP-SAT reference'); n++;
      } else {
        assert.ok(lamps.includes('IN-PAGE RE-PLAN'), 'api=off keeps the browser planner'); n++;
      }
      assert.deepStrictEqual(errors, [], 'no page errors'); n++;
      await page.close();
    }
    await browser.close();
    console.log(`OK: API test passed (${n} checks)`);
  } finally { srv.kill(); }
})().catch((e) => { console.error(e); process.exit(1); });
