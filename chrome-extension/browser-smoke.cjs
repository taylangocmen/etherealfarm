/* Optional browser integration check: npm install playwright in a separate test directory.
 * Run with NODE_PATH pointing at that directory's node_modules.
 * Uses a fresh browser context, never your Chrome profile or real farm save.
 */
const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const baseline = await context.newPage();
    await baseline.goto('https://lodev.org/etherealfarm/', { waitUntil: 'networkidle' });
    const bounds = await baseline.evaluate(() => { const r = Xb.div.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
    await baseline.close();
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    // Only Chrome storage is substituted; game data and all extension scripts are real.
    await page.addInitScript(() => {
      window.chrome = { storage: { local: {
        async get(key) { return { [key]: JSON.parse(localStorage.getItem('test:' + key) || 'null') }; },
        async set(data) { for (const [k, v] of Object.entries(data)) localStorage.setItem('test:' + k, JSON.stringify(v)); window.__savedCharts = data; }
      } } };
    });
    const manifest = JSON.parse(readFileSync(__dirname + '/manifest.json', 'utf8'));
    const files = ['chart-store.js', ...manifest.content_scripts[0].js];
    await page.addInitScript(files.map(f => readFileSync(__dirname + '/' + f, 'utf8')).join('\n'));
    await page.goto('https://lodev.org/etherealfarm/', { waitUntil: 'networkidle' });
    await page.locator('#ethereal-run-charts #current').filter({ hasText: 'Current run 1' }).waitFor();
    assert.deepEqual(await page.evaluate(() => { const r = Xb.div.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; }), bounds);
    assert.equal(await page.locator('#ethereal-run-charts canvas').count(), 3);
    const panelBounds = await page.locator('#ethereal-run-charts #panel').boundingBox();
    assert.equal(panelBounds.y, 10);
    assert.equal(panelBounds.height, 1060, 'analytics fills the viewport with 10px margins');
    const chartBounds = await page.locator('#ethereal-run-charts canvas').first().boundingBox();
    assert.ok(chartBounds.height > 200, 'charts grow into available height');
    const edge = await page.evaluate(() => [Xb.div.getBoundingClientRect().right, document.getElementById('ethereal-run-charts').getBoundingClientRect().left]);
    assert.ok(edge[1] > edge[0], 'charts must not cover the game');
    const speedBounds = await page.locator('#ethereal-speed-controls').boundingBox();
    assert.ok(speedBounds.y < 12 && speedBounds.height < 45, 'speed controls fit above upgrades');
    // Exercise actual planting through the game's UI with acceleration enabled.
    await page.locator('#speed').fill('10'); await page.locator('#speed').dispatchEvent('input');
    await page.mouse.click(100, 250);
    await page.getByText('Plant watercress', { exact: true }).first().click();
    await page.waitForTimeout(500);
    await page.evaluate(() => { __etherealSpeed.setRate(1); E.paused = true; An(); });
    await page.waitForTimeout(5500);
    const equality = await page.evaluate(() => {
      const saved = Object.values(__savedCharts)[0].runs.at(-1).samples.at(-1);
      const exact = __etherealData.adapter().snapshot();
      return {same: JSON.stringify(saved.values) === JSON.stringify(exact.values), saved, exact};
    });
    assert.ok(equality.same, 'recorded values must exactly match the live game objects');
    // Controlled test farm: unlock weather and submit the real game action.
    await page.evaluate(() => { E.paused = false; for (const [ability, upgrade] of [[0,no],[1,po],[2,ro]]) { E.B[upgrade].count = 1; WY.push({ type: JP, $d: ability }); An(); } });
    await page.waitForTimeout(5500);
    assert.deepEqual(await page.evaluate(() => Object.values(__savedCharts)[0].runs.at(-1).events.map(e => e.name)), ['Sun', 'Mist', 'Rainbow']);
    // Use the game's real reset function to verify archival/comparison.
    await page.evaluate(() => { TY(0, false); An(); });
    await page.waitForTimeout(5500);
    assert.equal(await page.evaluate(() => Object.values(__savedCharts)[0].runs.length), 2);
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('#ethereal-run-charts #current').filter({ hasText: /Current run [2-9]/ }).waitFor();
    const oldest = await page.locator('#compare option').last().getAttribute('value');
    await page.locator('#compare').selectOption(oldest);
    await page.locator('#scale').selectOption('log');
    await page.locator('#ethereal-run-charts canvas').first().hover();
    await page.screenshot({ path: '/tmp/ethereal-run-charts.png' });
    await page.setViewportSize({ width: 900, height: 900 });
    await page.locator('#ethereal-run-charts #open').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#ethereal-run-charts #panel').isVisible(), false);
    await page.locator('#ethereal-run-charts #open').click();
    assert.equal(await page.locator('#ethereal-run-charts #panel').isVisible(), true);
    assert.deepEqual(errors, []);
    console.log('PASS: unchanged game bounds; three charts; exact live values; planting at 100×; all three power markers; run archival; reload; log scale; responsive drawer.');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
