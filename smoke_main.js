// 本番ファイル スモークテスト（push前の最終確認）
// 使い方:  node smoke_main.js
//
// ../hub-a-nice-day/index_main.html と customers.html をローカルサーバで起動し、
// 【本番GASの実データ】を読み取り専用プロキシで流し込んで全画面を自動巡回。
// レンダリングエラー/JSエラーが1件でもあれば FAIL（exit 1）。
//
// ★安全性: GASへのGET（読み取り）だけ本物へ転送。POST（書き込み）は全て遮断して
//   'ok'を返すので、本番データには一切書き込まれない。
//
// なぜ必要か: DEVと本番ではデータの形が違うことがある（例: 本番のrresはオブジェクト
// 構造でDEVは空 → DEVでは絶対に踏めないクラッシュが本番で発生）。本番の実データで
// 全画面を開くことでこの種の事故をpush前に検出する。
//
// 依存: playwright（無ければ `npm i playwright && npx playwright install chromium`）
const path = require('path');
const fs = require('fs');
const http = require('http');

let chromium;
for (const base of [__dirname, path.join(process.env.LOCALAPPDATA || '', 'Temp', 'hub-verify')]) {
  try { chromium = require(path.join(base, 'node_modules', 'playwright')).chromium; break; } catch (e) {}
}
if (!chromium) { try { chromium = require('playwright').chromium; } catch (e) {} }
if (!chromium) {
  console.error('playwright が見つかりません。次を実行してください:');
  console.error('  npm i playwright && npx playwright install chromium');
  process.exit(1);
}

const MAIN_DIR = path.resolve(__dirname, '..', 'hub-a-nice-day');
const PORT = 8140;
const GAS_HOST = 'https://script.google.com';

(async () => {
  const server = http.createServer((req, res) => {
    const f = path.join(MAIN_DIR, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, ''));
    fs.readFile(f, (err, data) => {
      if (err) { res.writeHead(404); res.end('nf'); return; }
      res.writeHead(200, { 'Content-Type': path.extname(f) === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream' });
      res.end(data);
    });
  });
  await new Promise(r => server.listen(PORT, r));

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  let gasReads = 0, gasBlockedWrites = 0;
  await context.route(GAS_HOST + '/**', async route => {
    const req = route.request();
    if (req.method() === 'POST') {
      gasBlockedWrites++; // 書き込みは絶対に通さない
      await route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'ok' });
      return;
    }
    try { // 読み取りは本物のGASへ転送（実データでテストする）
      const r = await fetch(req.url(), { redirect: 'follow' });
      const body = await r.text();
      gasReads++;
      await route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body });
    } catch (e) {
      await route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'null' });
    }
  });
  await context.addInitScript(() => {
    sessionStorage.setItem('hub_currentUser', JSON.stringify({
      uid: 'h1', name: '見取大介', myNumber: 1, id: 1, badge: 'inspector',
      store: { id: 'honten', name: '本店', color: '#2563eb', bg: '#eff6ff', accent: '#1d4ed8' },
    }));
  });

  const problems = [];
  const checkPage = async (page, label) => {
    const body = await page.locator('body').innerText().catch(() => '');
    if (body.includes('レンダリングエラー')) problems.push(`${label}: レンダリングエラー表示`);
    if (body.includes('テスト版')) problems.push(`${label}: DEVバッジ残骸`);
  };

  // ── index_main.html: 全ビュー巡回 ──
  const page = await context.newPage();
  page.on('pageerror', e => problems.push('JSエラー: ' + String(e).slice(0, 140)));
  page.on('dialog', async d => { problems.push('予期しないダイアログ: ' + d.message().slice(0, 80)); await d.dismiss().catch(() => {}); });
  console.log('index_main.html を起動中（本番実データ・読み取り専用）...');
  await page.goto(`http://127.0.0.1:${PORT}/index_main.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(15000);
  await checkPage(page, '起動直後');
  for (const view of ['カレンダー', 'スケジュール', '代車管理', '🔔 車両管理', '空き枠検索']) {
    try {
      await page.getByText(view, { exact: true }).first().click({ timeout: 8000 });
      await page.waitForTimeout(3500);
      await checkPage(page, view);
      console.log(`  ✔ ${view}`);
    } catch (e) { problems.push(`${view}: 画面を開けない (${String(e).slice(0, 60)})`); }
  }
  // 三田店ビューも一巡（店舗切替はスケジュール画面に戻ってから）
  try {
    await page.keyboard.press('Escape'); // 空き枠検索等のオーバーレイを閉じる
    await page.waitForTimeout(800);
    const navOk = await page.evaluate(() => {
      const el = [...document.querySelectorAll('button,div')].find(b => b.textContent.trim().endsWith('スケジュール') && b.offsetParent !== null && b.textContent.length < 12);
      if (el) { el.click(); return true; } return false;
    });
    if (!navOk) throw new Error('スケジュールナビが見つからない');
    await page.waitForTimeout(2500);
    const clicked = await page.evaluate(() => {
      const el = [...document.querySelectorAll('button,div')].find(b => b.textContent.trim() === '三田店' && b.offsetParent !== null);
      if (el) { el.click(); return true; } return false;
    });
    if (!clicked) throw new Error('三田店ボタンが見つからない');
    await page.waitForTimeout(2500);
    await checkPage(page, '三田店ビュー');
    console.log('  ✔ 三田店切替');
  } catch (e) { problems.push('三田店切替: ' + String(e).slice(0, 60)); }
  await page.screenshot({ path: path.join(__dirname, 'smoke-main-last.png') });
  await page.close();

  // ── customers.html ──
  const page2 = await context.newPage();
  page2.on('pageerror', e => problems.push('customers JSエラー: ' + String(e).slice(0, 140)));
  console.log('customers.html を起動中...');
  await page2.goto(`http://127.0.0.1:${PORT}/customers.html`, { waitUntil: 'domcontentloaded' });
  await page2.waitForTimeout(15000);
  await checkPage(page2, '顧客リスト');
  const custBody = await page2.locator('body').innerText().catch(() => '');
  if (!custBody.includes('総件数')) problems.push('顧客リスト: 画面が表示されていない');
  else console.log('  ✔ 顧客リスト表示');
  await page2.close();

  await browser.close(); server.close();
  console.log(`\nGAS読み取り ${gasReads}件 / 遮断した書き込み ${gasBlockedWrites}件（本番データへの書き込みゼロ）`);
  if (problems.length) {
    console.error('\n★FAIL — push しないでください:');
    problems.forEach(p => console.error('  ✖ ' + p));
    process.exit(1);
  }
  console.log('★PASS — 全画面エラーなし。本番リポジトリで commit & push してOKです。');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
