// Browser test of the built page with assertions; exits non-zero on failure.
//   node test_page.cjs        (after `python build.py`)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'nct_control_tower_data.json'), 'utf8'));
const fmt = (x, d) => Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  await page.goto('file://' + path.join(__dirname, 'dist', 'test_full.html'));
  await page.waitForSelector('.pf-kpi');

  const kpis = () => page.$$eval('.pf-kpi .v', (els) => els.map((e) => e.textContent));
  const chips = () => page.$$eval('.pf-chip.act', (els) => els.map((e) => e.textContent));
  const blocking = () => page.$eval('.pf-stat .v', (e) => e.textContent);
  const lastReply = () => page.$$eval('.pf-msg.a', (els) => els[els.length - 1].textContent);
  // tiles count up to their new values over 0.8 s, so wait for the first tile and then let the rest finish
  const settle = async (want) => { await page.waitForFunction((w) => document.querySelector('.pf-kpi .v').textContent === w, want, { timeout: 15000 }); await page.waitForTimeout(1200); };
  const send = async (text) => {
    await page.fill('.pf-in input', text);
    await page.click('.pf-in button');
    await page.waitForFunction(() => !document.querySelector('.pf-in input').disabled, null, { timeout: 30000 });
  };

  // 1. the page shows the pipeline's numbers
  const nominal = data.optimised.kpis;
  await settle(`${fmt(nominal.avg_turnaround_days, 2)}days`);
  const k0 = await kpis();
  assert.strictEqual(k0[1], `${fmt(nominal.total_anchorage_wait_hrs, 0)}h`, 'anchorage wait tile');
  assert.strictEqual(k0[2], `${fmt(nominal.peak_yard_occupancy_pct, 1)}%`, 'peak yard tile');
  assert.strictEqual(await page.$$eval('.pf-gbar', (e) => e.length), data.optimised.schedule.length, 'one Gantt bar per vessel');

  // 2. the 3D yard reproduces the engine's blocking counts before and after grooming
  assert.strictEqual(await page.$$eval('.y3-box', (e) => e.length), data.yard.boxes_in_block, 'boxes in block');
  assert.strictEqual(await blocking(), String(data.yard.post_premarshal_blocking_inversions), 'blocking after grooming');
  await page.click('text=As landed');
  await page.waitForFunction((w) => document.querySelector('.pf-stat .v').textContent === w, String(data.yard.initial_blocking_inversions), { timeout: 5000 });

  // 3. a command re-plans in the page and lands on the CP-SAT reference result
  const late = data.reference_cases.find((c) => c.case === 'HR FARHA 6 h late').kpis;
  await send('Delay the next feeder by 6 hours due to Kutubdia fog');
  await settle(`${fmt(late.avg_turnaround_days, 2)}days`);
  assert.deepStrictEqual(await chips(), ['HR FARHA +6 h'], 'active change chip');
  assert.ok((await page.$$eval('.pf-term div', (e) => e.map((x) => x.textContent).join('\n'))).includes('converged'), 'solver log shows convergence');

  // 4. an unrecognised message changes nothing
  const before = await kpis();
  await send('what is the weather');
  assert.ok((await lastReply()).startsWith('I could not turn that into a change'), 'unrecognised message is declined');
  assert.deepStrictEqual(await kpis(), before, 'KPIs unchanged');

  // 5. reset restores the reference plan
  await send('Reset');
  await settle(`${fmt(nominal.avg_turnaround_days, 2)}days`);
  assert.deepStrictEqual(await chips(), [], 'no active changes after reset');

  // 6. phone width has no sideways scroll
  const phone = await browser.newPage({ viewport: { width: 390, height: 800 } });
  await phone.goto('file://' + path.join(__dirname, 'dist', 'test_full.html'));
  await phone.waitForSelector('.pf-kpi');
  assert.strictEqual(await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), 0, 'no horizontal overflow at 390 px');

  assert.deepStrictEqual(errors, [], 'no script errors');
  await browser.close();
  console.log('OK: page test passed (6 checks)');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
