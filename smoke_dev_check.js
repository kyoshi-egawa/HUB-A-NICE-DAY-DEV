// DEV版 真っ白診断（一時）: index_dev.html をローカル起動しJSエラー/Babel変換エラーを捕捉
const path = require('path');
const fs = require('fs');
const http = require('http');

let chromium;
for (const base of [__dirname, path.join(process.env.LOCALAPPDATA || '', 'Temp', 'hub-verify')]) {
  try { chromium = require(path.join(base, 'node_modules', 'playwright')).chromium; break; } catch (e) {}
}
if (!chromium) { try { chromium = require('playwright').chromium; } catch (e) {} }
if (!chromium) { console.error('playwright が見つかりません'); process.exit(1); }

const DIR = __dirname;
const PORT = 8141;

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

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  // GAS書き込み遮断・読み取りは空で返す（構文エラー検出が目的なのでデータ不要）
  await ctx.route('https://script.google.com/**', route => route.fulfill({ status: 200, contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' }));

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    // Babelの「500KB超はコード整形を省略」通知は無害（機能影響なし）なので除外
    if (m.text().includes('deoptimised the styling')) return;
    errors.push('CONSOLE: ' + m.text());
  });

  const target = process.argv[2] || 'index_dev.html';
  await page.goto(`http://localhost:${PORT}/${target}`, { waitUntil: 'networkidle' }).catch(e => errors.push('GOTO: ' + e.message));
  await page.waitForTimeout(2500);

  // React がマウントできたか（#root に中身があるか）
  const rootHtmlLen = await page.evaluate(() => (document.getElementById('root') || document.body).innerHTML.length).catch(() => 0);
  const shot = (process.env.SHOT && path.join(DIR, process.env.SHOT)) || path.join(DIR, 'smoke-dev-check.png');
  await page.screenshot({ path: shot }).catch(() => {});

  console.log('root/innerHTML length =', rootHtmlLen, rootHtmlLen < 200 ? '→ ほぼ空（真っ白の疑い）' : '→ 描画あり');
  if (errors.length) { console.log('--- エラー ---'); errors.slice(0, 15).forEach(e => console.log(e)); }
  else console.log('JSエラーは検出されませんでした');

  await browser.close();
  server.close();
  process.exit(errors.length || rootHtmlLen < 200 ? 1 : 0);
})();
