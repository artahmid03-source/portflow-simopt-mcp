const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(), p = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  await p.goto('file://' + __dirname + '/dist/test_full.html'); await p.waitForSelector('.pf-kpi'); await p.waitForTimeout(1500);
  const measure = () => p.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < 2000 ? requestAnimationFrame(f) : res(n / 2); }; requestAnimationFrame(f); }));
  console.log('idle', await measure());
  await p.click('.pf-scrub button'); console.log('playing', await measure()); await p.click('.pf-scrub button');
  await p.addStyleTag({ content: '.y3-stage{display:none}' }); await p.click('.pf-scrub button'); console.log('playing, yard hidden', await measure()); await p.click('.pf-scrub button');
  await p.addStyleTag({ content: '.pf-radar{display:none}' }); await p.click('.pf-scrub button'); console.log('playing, yard+radar hidden', await measure());
  await b.close();
})();
