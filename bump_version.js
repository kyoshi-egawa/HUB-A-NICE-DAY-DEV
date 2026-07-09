// バージョン一括更新ツール（システム全体で1バージョンを保証する）
// index_dev.html(APP_VERSION) / mobile.html(MOBILE_VERSION) / customers.html(APP_VERSION) を必ず同値にする。
//   使い方:
//     node bump_version.js         → 現在値を +0.01（例 1.37 → 1.38）
//     node bump_version.js 1.40    → 指定値に統一
//     node bump_version.js --check → 3ファイルが揃っているか確認のみ（揃っていなければ exit 1）
// ※本番(index_main.html)は port_to_main.js が DEV の値ごとコピーするので、ここでは触らない。
const fs=require('fs');
const files=[
  {f:'index_dev.html', re:/const APP_VERSION = '([\d.]+)'/,  tpl:v=>`const APP_VERSION = '${v}'`},
  {f:'mobile.html',    re:/const MOBILE_VERSION='([\d.]+)'/, tpl:v=>`const MOBILE_VERSION='${v}'`},
  {f:'customers.html', re:/const APP_VERSION='([\d.]+)'/,    tpl:v=>`const APP_VERSION='${v}'`},
];
const cur=files.map(x=>{
  const m=fs.readFileSync(x.f,'utf8').match(x.re);
  if(!m)throw new Error(`${x.f}: バージョン定義が見つかりません`);
  return m[1];
});
if(new Set(cur).size!==1){
  console.error('✖ バージョンが揃っていません:', files.map((x,i)=>`${x.f}=${cur[i]}`).join(' / '));
  console.error('  → 手動で揃えてから再実行してください。');
  process.exit(1);
}
if(process.argv[2]==='--check'){ console.log(`✔ 全ファイル一致: v${cur[0]}`); process.exit(0); }
const next=process.argv[2]||(parseFloat(cur[0])+0.01).toFixed(2);
files.forEach(x=>{
  const s=fs.readFileSync(x.f,'utf8');
  fs.writeFileSync(x.f, s.replace(x.re, x.tpl(next)));
});
console.log(`✔ v${cur[0]} → v${next}（index_dev / mobile / customers を統一）`);
