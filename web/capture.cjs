// Captures the README screenshots and prints what each copilot command did (exploratory; the asserted test is test_page.cjs).
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(), p = await b.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errs = []; p.on('console', (m) => m.type() === 'error' && errs.push(m.text())); p.on('pageerror', (e) => errs.push('PAGEERR ' + e.message));
  await p.goto('file://' + __dirname + '/dist/test_full.html'); await p.waitForSelector('.pf-kpi');
  const kpi = async () => p.$$eval('.pf-kpi .v', (e) => e.map((x) => x.textContent));
  const blocking = async () => p.$eval('.pf-stat .v', (e) => e.textContent);
  console.log('nominal kpis', await kpi(), 'blocking(after)', await blocking(), 'boxes', await p.$$eval('.y3-box', (e) => e.length), 'faces', await p.$$eval('.y3-box i', (e) => e.length));
  await p.click('text=As landed'); await p.waitForTimeout(300); console.log('blocking(before)', await blocking());
  await p.screenshot({ path: 'shots/01_nominal.png', fullPage: true });
  const cmd = async (text, shot) => {
    await p.fill('.pf-in input', text); await p.click('.pf-in button'); await p.waitForFunction(() => !document.querySelector('.pf-in input').disabled, null, { timeout: 30000 });
    await p.waitForTimeout(1300);
    console.log('\n>', text, '\n  kpis', (await kpi()).join(' | '), '\n  chips', await p.$$eval('.pf-chip.act', (e) => e.map((x) => x.textContent)), '\n  reply', (await p.$$eval('.pf-msg.a', (e) => e[e.length - 1].textContent)).replace(/\n/g, ' / ').slice(0, 330));
    if (shot) await p.screenshot({ path: 'shots/' + shot, fullPage: false });
  };
  await cmd('Delay the next feeder by 6 hours due to Kutubdia fog');
  await cmd('Take QGC-03 offline for 24 hours');
  await cmd('A storm delayed three ships by 12 hours and two yard cranes broke', '02_storm.png');
  await cmd('Stop off-dock evacuation', '03_no_icd.png');
  await p.waitForTimeout(2500); await p.screenshot({ path: 'shots/04_playing.png', clip: { x: 0, y: 0, width: 1440, height: 1560 } });
  await cmd('Only one pilot and tug set today');
  await cmd('what is the weather');
  await cmd('Reset');
  console.log('log tail', await p.$$eval('.pf-term div', (e) => e.slice(-4).map((x) => x.textContent)));
  await p.click('text=Replay'); await p.waitForTimeout(11000); console.log('after replay blocking', await blocking()); await p.click('text=As landed'); await p.waitForTimeout(1500);
  const fps = await p.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < 2000 ? requestAnimationFrame(f) : res(n / 2); }; document.querySelector('.pf-scrub button').click(); requestAnimationFrame(f); }));
  console.log('fps while playing', fps, 'errors', errs);
  const m = await b.newPage({ viewport: { width: 390, height: 800 } }); await m.goto('file://' + __dirname + '/dist/test_full.html'); await m.waitForSelector('.pf-kpi');
  console.log('mobile overflow', await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)); await m.screenshot({ path: 'shots/05_mobile.png', fullPage: true });
  await b.close();
})();
