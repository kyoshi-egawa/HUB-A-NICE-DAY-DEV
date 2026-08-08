// DEV実機を新GAS(会社アカウント)につないで、実データを読めているかを検証する。
// 読み取りは通し、書き込み(POST)は全遮断する。旧GASへのアクセスが1件でもあれば失敗にする。
const path = require('path');
const fs = require('fs');
const http = require('http');

let chromium;
for (const base of [__dirname, path.join(process.env.LOCALAPPDATA || '', 'Temp', 'hub-verify')]) {
  try { chromium = require(path.join(base, 'node_modules', 'playwright')).chromium; break; } catch (e) {}
}
if (!chromium) { console.error('playwright が見つかりません'); process.exit(1); }

const NEW_ID = 'AKfycbyNE1eVKjibSPLEA0HrVZI8NxEFKWQfMYQ6cKoM1Gznauy9AhfZqHzgs1zzMaxXnQ1_';
const OLD_ID = 'AKfycbxyWvIxIyC1EwJUfm4Fy8g6dpBytp7J9wTuT6Dujz-X7V-WzkGkN-bHw2l6rY_B1ST';
const DIR = __dirname;
const PORT = 8143;
const TARGET = process.argv[2] || 'index_dev.html';

(async () => {
  const server = http.createServer((req, res) => {
    const f = path.join(DIR, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, ''));
    fs.readFile(f, (err, data) => {
      if (err) { res.writeHead(404); res.end('nf'); return; }
      res.writeHead(200, { 'Content-Type': path.extname(f) === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream' });
      res.end(data);
    });
  });
  await new Promise(r => server.listen(PORT, r));

  const browser = await chromium.launch();
  const ctx = await browser.newContext();

  let blockedWrites = 0, oldHits = 0, newHits = 0;
  const reads = [];

  await ctx.route('https://script.google.com/**', async route => {
    const req = route.request();
    const url = req.url();
    if (url.includes(OLD_ID)) { oldHits++; return route.abort(); }
    if (req.method() === 'POST') { // 書き込みは通さない
      blockedWrites++;
      return route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'ok' });
    }
    newHits++;
    const m = url.match(/[?&]keys=([^&]*)/) || url.match(/[?&]key=([^&]*)/) || url.match(/[?&]action=([^&]*)/);
    try {
      const resp = await route.fetch();
      const body = await resp.text();
      reads.push({ what: m ? decodeURIComponent(m[1]).slice(0, 90) : '(?)', len: body.length });
      await route.fulfill({ response: resp, body });
    } catch (e) {
      // ページ遷移・終了で飛行中のリクエストが切れた場合は無視する（検証の対象外）
      try { await route.abort(); } catch (e2) {}
    }
  });

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    if (m.text().includes('deoptimised the styling')) return;
    errors.push('CONSOLE: ' + m.text());
  });

  await page.goto(`http://localhost:${PORT}/${TARGET}`, { waitUntil: 'networkidle' }).catch(e => errors.push('GOTO: ' + e.message));
  await page.waitForTimeout(9000); // GAS読み込みを待つ

  const rootLen = await page.evaluate(() => (document.getElementById('root') || document.body).innerHTML.length).catch(() => 0);
  const text = await page.evaluate(() => document.body.innerText || '').catch(() => '');
  await page.screenshot({ path: path.join(DIR, `verify-newgas-${TARGET.replace('.html', '')}.png`), fullPage: false }).catch(() => {});

  console.log(`\n=== ${TARGET} ===`);
  console.log(`新GASへの読み取り : ${newHits} 件`);
  console.log(`旧GASへのアクセス : ${oldHits} 件  ${oldHits ? '← ★残存あり' : '(なし)'}`);
  console.log(`遮断した書き込み  : ${blockedWrites} 件`);
  console.log(`描画量            : ${rootLen} 文字`);
  const big = reads.filter(r => r.len > 200).sort((a, b) => b.len - a.len).slice(0, 6);
  console.log('取得できたデータ（上位）:');
  big.forEach(r => console.log(`   ${String(r.len).padStart(7)}字  ${r.what}`));
  const totalRead = reads.reduce((s, r) => s + r.len, 0);
  console.log(`読み取り合計      : ${totalRead.toLocaleString()}字`);
  if (errors.length) { console.log('--- エラー ---'); errors.slice(0, 10).forEach(e => console.log(e)); }
  else console.log('JSエラー          : なし');

  await ctx.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
  await browser.close();
  server.close();
  const ok = oldHits === 0 && errors.length === 0 && rootLen > 200 && totalRead > 5000;
  console.log(ok ? '\n✔ PASS' : '\n✖ FAIL');
  process.exit(ok ? 0 : 1);
})();
