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
  for (const view of ['カレンダー', 'スケジュール', '代車管理', '車両管理', '空き枠検索']) {
    try {
      // 代車管理など特殊ビューに遷移した後もナビを確実に押せるよう evaluate でクリック
      const ok = await page.evaluate((v) => {
        const b = [...document.querySelectorAll('button')].find(el => el.textContent.includes(v) && el.offsetParent !== null && el.textContent.replace(/\s/g, '').length < 16);
        if (b) { b.scrollIntoView(); b.click(); return true; } return false;
      }, view);
      if (!ok) throw new Error('ナビボタンが見つからない');
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
  // 顧客ファイルのGAS読込は時に30秒超かかる（index_main巡回直後はGASスロットリングで特に遅い）。
  // 固定待機だと遅延で誤検知するためポーリング（最大44秒）。
  let custBody = '';
  for (let i = 0; i < 22; i++) {
    await page2.waitForTimeout(2000);
    custBody = await page2.locator('body').innerText().catch(() => '');
    if (custBody.includes('総件数')) break;
  }
  await checkPage(page2, '顧客リスト');
  if (!custBody.includes('総件数')) { problems.push('顧客リスト: 画面が表示されていない'); console.log('  [debug] custBody len=' + custBody.length + ' first120="' + custBody.slice(0, 120).replace(/\n/g, ' ') + '"'); }
  else console.log('  ✔ 顧客リスト表示');
  await page2.close();

  // ── mobile.html: ログイン→3タブ巡回 ──
  // ログインコードは本番スタッフリスト（読み取りのみ）から実在のmyNumberを取得して使う
  try {
    const mobileSrc = fs.readFileSync(path.join(MAIN_DIR, 'mobile.html'), 'utf8');
    const gasUrl = (mobileSrc.match(/const GAS_URL='([^']+)'/) || [])[1];
    const gasKey = (mobileSrc.match(/const GAS_API_KEY='([^']+)'/) || [])[1];
    let loginCode = '1'; // フォールバック（DEFAULT_STAFF先頭）
    try {
      const r = await fetch(`${gasUrl}?key=${encodeURIComponent('hub-v8-honten-staff-v2')}&apiKey=${encodeURIComponent(gasKey)}`, { redirect: 'follow' });
      const staff = JSON.parse(await r.text());
      const first = (Array.isArray(staff) ? staff : []).find(s => s && s.name && s.myNumber != null);
      if (first) loginCode = String(first.myNumber);
    } catch (e) { console.log('  (スタッフリスト取得失敗→コード1でログイン試行)'); }
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await mctx.route(GAS_HOST + '/**', async route => {
      const req = route.request();
      if (req.method() === 'POST') {
        gasBlockedWrites++;
        await route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'ok' });
        return;
      }
      try {
        const r = await fetch(req.url(), { redirect: 'follow' });
        const body = await r.text();
        gasReads++;
        await route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body });
      } catch (e) {
        await route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'null' });
      }
    });
    const page3 = await mctx.newPage();
    page3.on('pageerror', e => problems.push('mobile JSエラー: ' + String(e).slice(0, 140)));
    page3.on('dialog', async d => { problems.push('mobile 予期しないダイアログ: ' + d.message().slice(0, 80)); await d.dismiss().catch(() => {}); });
    console.log('mobile.html を起動中（本番実データ・読み取り専用）...');
    await page3.goto(`http://127.0.0.1:${PORT}/mobile.html`, { waitUntil: 'domcontentloaded' });
    await page3.waitForTimeout(8000); // Babel変換＋スタッフリスト読込
    await page3.fill('input[type="tel"]', loginCode);
    await page3.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(el => el.textContent.includes('SIGN IN'));
      if (b) b.click();
    });
    await page3.waitForTimeout(12000); // ログイン演出8秒＋フェード＋初回fetchAll
    const mBody = await page3.locator('body').innerText().catch(() => '');
    if (mBody.includes('レンダリングエラー')) problems.push('mobile 起動直後: レンダリングエラー表示');
    if (mBody.includes('SIGN IN')) problems.push('mobile: ログインできていない（コード' + loginCode + '）');
    for (const tab of ['カレンダー', 'スケジュール', '代車']) {
      const ok = await page3.evaluate((t) => {
        // タブはbuttonではなく onClick付きdiv。最深のラベルdivをクリックすればReactイベントがバブルする
        const target = [...document.querySelectorAll('div')].filter(el => el.textContent.includes(t) && el.textContent.replace(/\s/g, '').length < 10).pop();
        if (target) { target.click(); return true; } return false;
      }, tab);
      if (!ok) { problems.push(`mobile ${tab}: タブが見つからない`); continue; }
      await page3.waitForTimeout(2500);
      const b = await page3.locator('body').innerText().catch(() => '');
      if (b.includes('レンダリングエラー')) problems.push(`mobile ${tab}: レンダリングエラー表示`);
      else console.log(`  ✔ mobile ${tab}`);
    }
    await page3.screenshot({ path: path.join(__dirname, 'smoke-main-mobile.png') });
    await mctx.close();
  } catch (e) { problems.push('mobile: スモーク実行失敗 ' + String(e).slice(0, 120)); }

  await browser.close(); server.close();
  console.log(`\nGAS読み取り ${gasReads}件 / 遮断した書き込み ${gasBlockedWrites}件（本番データへの書き込みゼロ）`);
  if (problems.length) {
    console.error('\n★FAIL — push しないでください:');
    problems.forEach(p => console.error('  ✖ ' + p));
    process.exit(1);
  }
  console.log('★PASS — 全画面エラーなし。本番リポジトリで commit & push してOKです。');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
