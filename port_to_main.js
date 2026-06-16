// DEV→本番 移植スクリプト
// 使い方:  node port_to_main.js
//
// index_dev.html → ../hub-a-nice-day/index_main.html
// customers.html → ../hub-a-nice-day/customers.html
// をコピーし、環境固有の差分（STOR・タイトル・DEVバッジ・配色）を本番用に変換する。
//
// ★安全装置: 各置換ルールは「DEV側に必ず存在するはず」のパターン。1件もマッチしない
//   ルールがあれば、DEV側のコードが変わってパターンが古くなった合図なので中断する
//   （黙って移植して配色やSTORが混ざる事故を防ぐ）。最後にDEVマーカー残骸も全チェック。
const fs = require('fs');
const path = require('path');

const DEV_DIR = __dirname;
const MAIN_DIR = path.resolve(__dirname, '..', 'hub-a-nice-day');

// [検索文字列, 置換文字列, 期待最少件数] — 文字列は完全一致（正規表現ではない）
const INDEX_RULES = [
  // 接続先データの分離（最重要）
  ["const STOR = 'hub-v8-dev-';", "const STOR = 'hub-v8-';", 1],
  // タイトル
  ['<title>Hub a Nice Day v1.0 [DEV]</title>', '<title>Hub a Nice Day v1.0</title>', 1],
  // 環境識別の配色: 全体背景・ログイン画面（オレンジ→青）
  ['linear-gradient(140deg,#7c2d12,#EA580C,#f97316)', 'linear-gradient(140deg,#1e3a8a,#1d4ed8,#2563eb)', 3],
  // ヘッダー背景（オレンジ単色→青グラデーション）
  ["<header ref={headerRef} style={{background:'#EA580C',", "<header ref={headerRef} style={{background:'linear-gradient(135deg,#1e3a8a,#1d4ed8)',", 1],
  // ヘッダーロゴ文字色
  ["gap:7,fontSize:16,fontWeight:800,color:'#9a3412'", "gap:7,fontSize:16,fontWeight:800,color:'white'", 1],
  // 戻るボタン（DEVグレー→本番グリーン）
  ["const BACK_S   ={display:'flex',alignItems:'center',gap:4,padding:'5px 11px',background:'#f3f4f6',border:'none',borderRadius:6,cursor:'pointer',fontWeight:600,fontSize:12,color:'#374151'};",
   "const BACK_S   ={display:'flex',alignItems:'center',gap:4,padding:'5px 11px',background:'#16a34a',border:'none',borderRadius:6,cursor:'pointer',fontWeight:700,fontSize:12,color:'white'};", 1],
  ["<button onClick={onClose} style={{padding:'11px 14px',background:'#f3f4f6',border:'none',borderRadius:9,fontWeight:600,cursor:'pointer',fontSize:12}}>戻る</button>",
   "<button onClick={onClose} style={{padding:'11px 14px',background:'#16a34a',border:'none',borderRadius:9,fontWeight:700,cursor:'pointer',fontSize:12,color:'white'}}>戻る</button>", 2],
];
// 正規表現ルール（DEVバッジspan・キャッシュバスト）
const INDEX_REGEX_RULES = [
  [/\s*<span style=\{\{fontSize:10,fontWeight:700,padding:'2px 8px',borderRadius:10,background:'#FFF7ED',color:'#9A3412',border:'2px solid #EA580C',flexShrink:0\}\}>⚠ テスト版（DEV）<\/span>/g, '', 1, 'DEVバッジspan'],
  [/\s*\{\/\* ===== DEV版警告バナー ===== \*\/\}/g, '', 0, 'DEVバナーコメント'],
  [/force-deploy-\d+/g, 'force-deploy-' + Date.now(), 1, 'force-deployタイムスタンプ'],
  // 自動アップデート検知のビルド識別子をデプロイ毎に更新（旧タブが新版を検知してバナー表示）
  [/__APP_BUILD='build-\d+'/, "__APP_BUILD='build-" + Date.now() + "'", 1, 'APP_BUILDタイムスタンプ'],
];
const CUST_RULES = [
  ["const STOR='hub-v8-dev-';", "const STOR='hub-v8-';", 1],
];
const CUST_REGEX_RULES = [
  // 自動アップデート検知のビルド識別子をデプロイ毎に更新
  [/__APP_BUILD='build-\d+'/, "__APP_BUILD='build-" + Date.now() + "'", 1, 'APP_BUILDタイムスタンプ'],
];
// 変換後にあってはならない文字列（残骸チェック）
const FORBIDDEN = ['hub-v8-dev', '[DEV]', 'テスト版（DEV）', 'DEV版警告バナー',
  'linear-gradient(140deg,#7c2d12', "header ref={headerRef} style={{background:'#EA580C'"];

let failed = false;
const countOf = (s, needle) => s.split(needle).length - 1;

function port(srcName, dstName, rules, regexRules) {
  const src = path.join(DEV_DIR, srcName);
  const dst = path.join(MAIN_DIR, dstName);
  let s = fs.readFileSync(src, 'utf8');
  console.log(`\n=== ${srcName} → ${dstName} ===`);
  for (const [from, to, min] of rules) {
    const c = countOf(s, from);
    if (c < min) {
      console.error(`  ✖ パターン未検出(${c}/${min}): ${from.slice(0, 60)}...`);
      console.error('    → DEV側のコードが変わった可能性。このルールを更新してから再実行。');
      failed = true; continue;
    }
    s = s.split(from).join(to);
    console.log(`  ✔ 置換 ${c}件: ${from.slice(0, 50)}...`);
  }
  for (const [re, to, min, label] of (regexRules || [])) {
    const c = (s.match(re) || []).length;
    if (c < min) {
      console.error(`  ✖ パターン未検出(${c}/${min}): ${label}`);
      failed = true; continue;
    }
    s = s.replace(re, to);
    console.log(`  ✔ 置換 ${c}件: ${label}`);
  }
  for (const bad of FORBIDDEN) {
    const c = countOf(s, bad);
    if (c > 0) { console.error(`  ✖ DEV残骸 ${c}件: ${bad}`); failed = true; }
  }
  if (!failed) {
    fs.writeFileSync(dst, s);
    console.log(`  → 書き込み完了: ${dst}`);
  }
}

if (!fs.existsSync(MAIN_DIR)) { console.error('本番リポジトリが見つかりません: ' + MAIN_DIR); process.exit(1); }
port('index_dev.html', 'index_main.html', INDEX_RULES, INDEX_REGEX_RULES);
port('customers.html', 'customers.html', CUST_RULES, CUST_REGEX_RULES);

if (failed) {
  console.error('\n★中断: 上記の✖を解消してから再実行してください（本番ファイルは書き込み済みのものだけ更新）。');
  process.exit(1);
}
console.log('\n★完了。次の手順:');
console.log('  1. node smoke_main.js  ← 本番実データで全画面スモーク（必須・PASSするまでpush禁止）');
console.log('  2. cd ../hub-a-nice-day && git diff で確認 → commit & push');
