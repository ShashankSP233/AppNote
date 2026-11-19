// Drives the UI in a real browser to confirm it loads, signs in and renders
// each tab without a console error.

import puppeteer from 'puppeteer-core';
import fs from 'node:fs/promises';

const BASE = process.env.BASE || 'http://localhost:3000';
const SHOTS = process.env.SHOT_DIR || './sample-output/screens';

const errors = [];
let pass = 0;
let fail = 0;

const ok = (m) => { pass += 1; console.log(`  ok   ${m}`); };
const bad = (m) => { fail += 1; console.log(`  FAIL ${m}`); };

async function main() {
  await fs.mkdir(SHOTS, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 980 });

  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));

  // --- Login ---------------------------------------------------------------
  console.log('\n1. Login screen');
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  const title = await page.$eval('.login-card h1', (n) => n.textContent);
  title.includes('Approval Note') ? ok('login screen renders') : bad(`unexpected title: ${title}`);
  await page.screenshot({ path: `${SHOTS}/01-login.png` });

  await page.type('input[name=username]', 'jaswinder');
  await page.type('input[name=password]', process.env.DEMO_PASSWORD || 'ChangeMe123!');
  await Promise.all([
    page.click('button[type=submit]'),
    page.waitForSelector('#app:not([hidden])', { timeout: 10000 }),
  ]);
  ok('signed in');

  // --- Note list -----------------------------------------------------------
  console.log('\n2. Note list');
  await page.waitForSelector('table.data tbody tr, .empty', { timeout: 8000 });
  const rows = await page.$$eval('table.data tbody tr', (nodes) => nodes.length);
  rows > 0 ? ok(`${rows} note(s) listed`) : bad('no notes listed');
  await page.screenshot({ path: `${SHOTS}/02-list.png`, fullPage: true });

  // --- Open the note -------------------------------------------------------
  console.log('\n3. Note tabs');
  // Prefer a note still in draft: an approved one is locked, so the editing
  // controls are correctly absent and there would be less to check.
  const draftRow = await page.evaluateHandle(() => {
    const rows = [...document.querySelectorAll('table.data tbody tr')];
    return rows.find((r) => r.querySelector('.badge.draft')) || rows[0];
  });
  await Promise.all([
    draftRow.asElement().click(),
    page.waitForSelector('.tabs', { timeout: 8000 }),
  ]);

  const tabs = ['details', 'quotations', 'compare', 'items', 'accounts', 'schedule', 'workflow'];
  for (const [index, tab] of tabs.entries()) {
    await page.click(`[data-tab="${tab}"]`);
    await page.waitForFunction(
      (t) => document.querySelector(`[data-tab="${t}"]`)?.classList.contains('active')
        && document.getElementById('tab-body')?.innerHTML.length > 60,
      { timeout: 8000 }, tab,
    );
    const rendered = await page.$eval('#tab-body', (n) => ({
      length: n.innerHTML.length,
      empty: Boolean(n.querySelector('.empty')),
    }));
    if (rendered.length > 200) ok(`${tab} tab renders (${rendered.length} chars)`);
    else if (rendered.empty) ok(`${tab} tab renders its empty state`);
    else bad(`${tab} tab is thin (${rendered.length} chars)`);
    await page.screenshot({ path: `${SHOTS}/0${index + 3}-${tab}.png`, fullPage: true });
  }

  // --- The review screen, the key surface ----------------------------------
  console.log('\n4. Quotation review screen');
  await page.click('[data-tab="quotations"]');
  await page.waitForSelector('[data-review]', { timeout: 8000 });
  await page.click('[data-review]');
  await page.waitForSelector('.review-split', { timeout: 8000 });

  const hasPreview = await page.$('.doc-preview iframe, .doc-preview img, .doc-preview .no-file');
  hasPreview ? ok('the attached copy pane is present') : bad('no preview pane');

  const lineInputs = await page.$$eval('tr[data-line] input[name=description]', (n) => n.length);
  lineInputs > 0 ? ok(`${lineInputs} quoted line(s) are editable`) : bad('lines are not editable');

  const headerFields = await page.$$eval('#quote-form input', (n) => n.length);
  headerFields > 10 ? ok(`${headerFields} header fields are editable`) : bad('header fields missing');

  await page.screenshot({ path: `${SHOTS}/10-review.png`, fullPage: true });

  // --- Heading colour and revisions ---------------------------------------
  console.log('\n4b. Heading colour and revisions');
  await page.click('#back-to-quotes');
  await page.waitForSelector('[data-review]', { timeout: 8000 });

  const offers = await page.$eval('#view', (n) => n.dataset.offers);
  ['competitive', 'limited', 'single'].includes(offers)
    ? ok(`the note is marked "${offers}" by how many vendors quoted`)
    : bad(`unexpected offer level: ${offers}`);

  const headBg = await page.$eval('table.data th', (n) => getComputedStyle(n).backgroundColor);
  ok(`table headings render as ${headBg}`);

  const keyText = await page.$eval('.offer-key', (n) => n.textContent.trim()).catch(() => null);
  keyText ? ok(`the colour is explained on screen: "${keyText}"`) : bad('no key shown for the heading colour');

  const reviseButtons = await page.$$eval('[data-revise]', (n) => n.length);
  reviseButtons > 0 ? ok(`${reviseButtons} offer(s) can be revised`) : bad('no revise control');

  // Open the revise dialog without submitting it.
  await page.click('[data-revise]');
  await page.waitForSelector('#revise-form', { timeout: 8000 });
  const hasReason = await page.$('#revise-form input[name=revision_note]');
  hasReason ? ok('the revision asks why it was revised') : bad('no reason field');
  await page.click('#modal-close');

  // --- Comparison grid -----------------------------------------------------
  console.log('\n5. Comparison grid');
  await page.click('[data-tab="compare"]');
  await page.waitForSelector('table.compare', { timeout: 8000 });
  const compareRows = await page.$$eval('table.compare tbody tr', (n) => n.length);
  compareRows > 12 ? ok(`comparison has ${compareRows} rows across every axis`) : bad(`only ${compareRows} rows`);

  const sections = await page.$$eval('table.compare tr.section th', (n) => n.map((x) => x.textContent.trim()));
  const expected = ['Commercial', 'Delivery', 'Payment terms'];
  expected.every((s) => sections.some((x) => x.includes(s)))
    ? ok(`sections present: ${sections.join(', ')}`)
    : bad(`sections missing, got: ${sections.join(', ')}`);

  await page.screenshot({ path: `${SHOTS}/11-compare.png`, fullPage: true });

  // --- Accounts ------------------------------------------------------------
  console.log('\n6. Accounts screen as the accounts user');
  await page.click('#logout');
  await page.waitForSelector('#login:not([hidden])', { timeout: 8000 });
  await page.type('input[name=username]', 'accounts');
  await page.type('input[name=password]', process.env.DEMO_PASSWORD || 'ChangeMe123!');
  await Promise.all([
    page.click('button[type=submit]'),
    page.waitForSelector('#app:not([hidden])', { timeout: 10000 }),
  ]);
  // Signing back in restores the previous hash, which is a note page. Changing
  // only the fragment does not reload, so wait for the list itself to appear
  // rather than for the navigation.
  await page.evaluate(() => { window.location.hash = '#notes'; });
  await page.waitForFunction(
    () => document.querySelector('#view h1')?.textContent.includes('Approval notes'),
    { timeout: 8000 },
  );
  await page.waitForSelector('table.data tbody tr', { timeout: 8000 });
  // The accounts screen needs a note that actually has priced lines.
  const pricedRow = await page.evaluateHandle(() => {
    const rows = [...document.querySelectorAll('table.data tbody tr')];
    return rows.find((r) => {
      const value = r.querySelector('td.num');
      return value && Number(value.textContent.replace(/[^0-9.]/g, '')) > 0;
    }) || rows[0];
  });
  await Promise.all([
    pricedRow.asElement().click(),
    page.waitForSelector('.tabs', { timeout: 8000 }),
  ]);
  await page.click('[data-tab="accounts"]');
  await page.waitForSelector('#tax-body', { timeout: 8000 });

  const taxRows = await page.$$eval('tr[data-tax]', (n) => n.length);
  taxRows > 0 ? ok(`${taxRows} line(s) available for item-wise tax verification`) : bad('no tax rows');

  const tdsSelect = await page.$('select[name=tds_section]');
  tdsSelect ? ok('TDS section picker present') : bad('no TDS picker');

  await page.click('#run-checklist');
  await page.waitForFunction(
    () => !document.getElementById('checklist-output')?.innerHTML.includes('spinner'),
    { timeout: 10000 },
  );
  const findings = await page.$$eval('#checklist-output .notice', (n) => n.length);
  findings > 0 ? ok(`the checklist returned ${findings} finding(s)`) : bad('checklist empty');

  await page.screenshot({ path: `${SHOTS}/12-accounts.png`, fullPage: true });

  // --- Masters -------------------------------------------------------------
  console.log('\n7. Masters');
  await page.click('[data-nav=masters]');
  await page.waitForSelector('table.data', { timeout: 8000 });
  ok('masters screen renders');
  await page.screenshot({ path: `${SHOTS}/13-masters.png`, fullPage: true });

  // --- Mobile --------------------------------------------------------------
  console.log('\n8. Narrow viewport');
  await page.setViewport({ width: 420, height: 880 });
  await page.goto(`${BASE}/#notes`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('table.data, .empty', { timeout: 8000 });
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  overflow <= 2 ? ok('no horizontal overflow at 420px') : bad(`overflows by ${overflow}px`);
  await page.screenshot({ path: `${SHOTS}/14-mobile.png`, fullPage: true });

  await browser.close();

  console.log('\n9. Console errors');
  const real = errors.filter((e) => !/favicon|404 \(Not Found\)/i.test(e));
  if (real.length) {
    bad(`${real.length} console error(s)`);
    for (const error of real.slice(0, 8)) console.log(`     ${error.slice(0, 140)}`);
  } else {
    ok('no console errors');
  }

  console.log(`\nPassed ${pass}, failed ${fail}`);
  console.log(`Screenshots in ${SHOTS}`);
  process.exitCode = fail ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
