// Hub a Nice Day - GAS server v10 (snapshots / restore)
// Big values are stored as Google Drive files (not spreadsheet cells),
// so the sheet stays small and every write is fast. Small values stay in the sheet.
// Backward compatible: still reads old single-cell and old __CHUNKED__ row data.
//
// v10 追加（時点スナップショット & 復旧）:
//  - 30分ごと(intradaySnapshot)と毎朝2時(dailySnapshot)に、実データ（Drive実体まで解決した実値）を
//    Driveの hubdata_snapshots フォルダへJSONで丸ごと保存。本番/DEVを別々に保存。
//  - doGet ?action=snapList  … その環境の保存時点の一覧（新しい順・要約件数つき）
//  - doGet ?action=snapRead  … 指定した時点の中身（プレビュー用）
//  - doPost action=snapRestore … 指定した時点に全データを戻す（実行直前に現状も自動保存＝やり直し可）
//  - 30分ごとの保存は48時間分、日次は90日分を保持し、超過分は自動削除。
//  ※既存の毎朝2時 dailyBackup（シート丸ごとコピー）はそのまま残す（従来の安全網）。
//    ただしシートコピーは大きいデータ(Drive保管)の実体を含まないため、復旧は必ずスナップショットを使うこと。
//  ※初回のみ setupSnapshotTriggers() をGASエディタから1回実行してトリガー登録が必要。DriveApp権限の再承認も要る。

const SHEET_NAME = 'hubdata';
const BACKUP_SHEET_PREFIX = 'backup_';
const BACKUP_KEEP_DAYS = 90;
const HUB_API_KEY = 'hub2026SandaHonten!9xKy';

var BIG_THRESHOLD = 30000;            // values longer than this go to Drive
var FILE_MARKER = '__DRIVEFILE__';    // cell marker meaning "value is in a Drive file"
var CHUNK_MARKER = '__CHUNKED__:';    // legacy marker (v7/v8), read-only support
var DRIVE_FOLDER = 'hubdata_blobs';

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.getRange(1, 1).setValue('key');
    sheet.getRange(1, 2).setValue('value');
    sheet.getRange(1, 3).setValue('updated');
  }
  return sheet;
}

// read ONLY column 1 (keys) - never load big value cells
function findRow(sheet, key) {
  var last = sheet.getLastRow();
  if (last < 1) return -1;
  var keys = sheet.getRange(1, 1, last, 1).getValues();
  for (var i = 1; i < keys.length; i++) {
    if (keys[i][0] === key) return i + 1;
  }
  return -1;
}

function makeResponse(text) {
  var output = ContentService.createTextOutput(text);
  output.setMimeType(ContentService.MimeType.TEXT);
  return output;
}

function writeRow(sheet, key, value, now) {
  var row = findRow(sheet, key);
  if (row === -1) {
    sheet.appendRow([key, value, now]);
  } else {
    sheet.getRange(row, 2).setValue(value);
    sheet.getRange(row, 3).setValue(now);
  }
}

// legacy cleanup: remove old key__chunkN rows (column 1 only, fast)
function deleteChunks(sheet, key) {
  var last = sheet.getLastRow();
  if (last < 2) return;
  var keys = sheet.getRange(1, 1, last, 1).getValues();
  var prefix = key + '__chunk';
  var rowsToDelete = [];
  for (var i = 1; i < keys.length; i++) {
    var k = keys[i][0];
    if (k && String(k).indexOf(prefix) === 0) rowsToDelete.push(i + 1);
  }
  rowsToDelete.sort(function(a, b) { return b - a; });
  rowsToDelete.forEach(function(r) { sheet.deleteRow(r); });
}

function invalidateCache(key) {
  try {
    var cache = CacheService.getScriptCache();
    cache.remove(key);
    for (var i = 0; i < 100; i++) cache.remove(key + '__chunk' + i);
  } catch (ce) {}
}

function getBlobFolder() {
  var it = DriveApp.getFoldersByName(DRIVE_FOLDER);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(DRIVE_FOLDER);
}

function driveWrite(key, content) {
  var folder = getBlobFolder();
  var fname = key + '.txt';
  var it = folder.getFilesByName(fname);
  if (it.hasNext()) {
    it.next().setContent(content);
  } else {
    folder.createFile(fname, content);
  }
}

function driveRead(key) {
  var folder = getBlobFolder();
  var it = folder.getFilesByName(key + '.txt');
  if (it.hasNext()) return it.next().getBlob().getDataAsString();
  return null;
}

// 1キー分の値文字列を読む（キャッシュ→シート→Drive/レガシーチャンクの順。doGetの単発・一括の共通部）
// rowHint: 呼び出し側が既に行番号を知っていれば渡す（-2なら未調査＝ここでfindRowする）
function readOneValue(sheet, cache, key, rowHint) {
  var cached = cache.get(key);
  if (cached !== null && cached.indexOf(CHUNK_MARKER) !== 0 && cached !== FILE_MARKER) {
    return cached;
  }
  var row = (rowHint === -2) ? findRow(sheet, key) : rowHint;
  if (row === -1) return 'null';
  var value = sheet.getRange(row, 2).getValue();
  value = (value === '' || value === null || value === undefined) ? 'null' : String(value);

  // value lives in a Drive file
  if (value === FILE_MARKER) {
    var c = driveRead(key);
    if (c === null || c === '') c = 'null';
    try { if (c.length < 90000) cache.put(key, c, 60); } catch (ce) {}
    return c;
  }

  // legacy chunked (v7/v8) - read separate __chunkN rows and join
  if (value.indexOf(CHUNK_MARKER) === 0) {
    var numChunks = parseInt(value.substring(CHUNK_MARKER.length), 10) || 0;
    var result = '';
    for (var j = 0; j < numChunks; j++) {
      var cr = findRow(sheet, key + '__chunk' + j);
      if (cr !== -1) {
        var cv = sheet.getRange(cr, 2).getValue();
        result += (cv === null || cv === undefined) ? '' : String(cv);
      }
    }
    if (!result) result = 'null';
    try { if (result.length < 90000) cache.put(key, result, 60); } catch (ce) {}
    return result;
  }

  try { cache.put(key, value, 60); } catch (ce) {}
  return value;
}

function doGet(e) {
  if (!e.parameter || e.parameter.apiKey !== HUB_API_KEY) {
    return makeResponse('unauthorized');
  }
  try {
    var cache = CacheService.getScriptCache();

    // v10: 保存時点の一覧（その環境の index をそのまま返す。新しい順・要約件数つき）
    if (e.parameter.action === 'snapList') {
      var pfxL = String(e.parameter.prefix || '');
      if (SNAP_ENV_PREFIXES.indexOf(pfxL) < 0) return makeResponse('error: bad prefix');
      var sheetL = getSheet();
      var raw = readOneValue(sheetL, cache, pfxL + 'snap-index', -2);
      return makeResponse((raw && raw !== 'null') ? raw : '[]');
    }
    // v10: 指定した時点の中身（プレビュー用。ファイル名は必ずその環境プレフィックスで始まること）
    if (e.parameter.action === 'snapRead') {
      var pfxR = String(e.parameter.prefix || '');
      var fileR = String(e.parameter.file || '');
      if (SNAP_ENV_PREFIXES.indexOf(pfxR) < 0 || fileR.indexOf(pfxR) !== 0) return makeResponse('error: bad params');
      var folderR = snapFolder();
      var itR = folderR.getFilesByName(fileR);
      if (!itR.hasNext()) return makeResponse('error: not found');
      return makeResponse(itR.next().getBlob().getDataAsString());
    }

    // 一括読み: ?keys=a,b,c → {"a":"<値文字列|null>", ...} のJSON。
    // フロントのポーリングを21リクエスト→1リクエストにするための同時実行数対策。
    if (e.parameter.keys) {
      var ks = String(e.parameter.keys).split(',').slice(0, 40);
      var sheet0 = getSheet();
      // キー列を1回だけ読んで行番号を索引化（キー数ぶんfindRowを繰り返さない）
      var last = sheet0.getLastRow();
      var rowOf = {};
      if (last >= 1) {
        var colKeys = sheet0.getRange(1, 1, last, 1).getValues();
        for (var i = 1; i < colKeys.length; i++) {
          var kk = colKeys[i][0];
          if (kk && !(kk in rowOf)) rowOf[kk] = i + 1;
        }
      }
      var out = {};
      for (var m = 0; m < ks.length; m++) {
        var k = ks[m];
        if (!k) continue;
        out[k] = readOneValue(sheet0, cache, k, (k in rowOf) ? rowOf[k] : -1);
      }
      return makeResponse(JSON.stringify(out));
    }

    var key = e.parameter && e.parameter.key;
    if (!key) return makeResponse('null');
    // 単発読みはキャッシュヒット時にシートを開かない（従来動作の維持）
    var cachedOne = cache.get(key);
    if (cachedOne !== null && cachedOne.indexOf(CHUNK_MARKER) !== 0 && cachedOne !== FILE_MARKER) {
      return makeResponse(cachedOne);
    }
    var sheet = getSheet();
    return makeResponse(readOneValue(sheet, cache, key, -2));
  } catch (err) {
    return makeResponse('error: ' + err.message);
  }
}

// 保存失敗の通知メール。宛先はシート上の notify-emails マップに登録済みのアドレスのみ
// （リクエストで任意の宛先を指定できるとAPIキー漏洩時に踏み台になるため、宛先はサーバー側で解決する）。
// 予約操作者本人が登録済みならその人へ、未登録なら登録者全員へ送る。
// 注意: MailApp を使うため、初回はデプロイ更新時に権限の再承認が必要。
function handleNotifyFail(body) {
  try {
    var emailsKey = String(body.emailsKey || '');
    if (!/^hub-v8-(dev-)?notify-emails$/.test(emailsKey)) return makeResponse('error: bad emailsKey');
    var sheet = getSheet();
    var row = findRow(sheet, emailsKey);
    if (row === -1) return makeResponse('error: no recipients');
    var raw = String(sheet.getRange(row, 2).getValue() || '');
    if (raw === FILE_MARKER) raw = driveRead(emailsKey) || '';
    var map;
    try { map = JSON.parse(raw); } catch (ex) { return makeResponse('error: no recipients'); }
    if (!map || typeof map !== 'object') return makeResponse('error: no recipients');
    var to = map[body.user] ? [map[body.user]] : Object.keys(map).map(function(k){ return map[k]; });
    to = to.filter(function(a){ return a && String(a).indexOf('@') > 0; });
    if (to.length === 0) return makeResponse('error: no recipients');
    var env = body.env === 'DEV' ? '【DEV】' : '';
    MailApp.sendEmail(
      to.join(','),
      env + '【Hub a Nice Day】予約の保存が確認できませんでした',
      String(body.detail || '予約の保存が確認できませんでした。アプリで該当日を確認してください。') +
      '\n\n--\nこのメールは Hub a Nice Day の自動通知です（返信不要）。'
    );
    return makeResponse('ok');
  } catch (err) {
    return makeResponse('error: ' + err.message);
  }
}

function doPost(e) {
  var contents = e.postData && e.postData.contents;
  if (!contents) return makeResponse('error: no body');
  var body;
  try { body = JSON.parse(contents); } catch (ex) { return makeResponse('error: invalid JSON'); }
  if (body.apiKey !== HUB_API_KEY) { return makeResponse('unauthorized'); }

  // 通知メールはシートを書かないのでロック不要。混雑（ロック詰まり）の時こそ送れる必要がある
  if (body.action === 'notifyFail') return handleNotifyFail(body);

  // v10: 復旧（指定した時点に全データを戻す）。実行直前に現状も自動保存する（やり直し可）
  if (body.action === 'snapRestore') {
    var lockR = LockService.getScriptLock();
    var lockedR = false;
    try { lockR.waitLock(25000); lockedR = true; } catch (leR) { return makeResponse('error: lock_timeout'); }
    try {
      var pfxRs = String(body.prefix || '');
      if (SNAP_ENV_PREFIXES.indexOf(pfxRs) < 0) return makeResponse('error: bad prefix');
      return makeResponse(snapRestore(pfxRs, String(body.file || '')));
    } catch (erR) { return makeResponse('error: ' + erR.message); }
    finally { if (lockedR) lockR.releaseLock(); }
  }
  // v10: 手動スナップショット（動作確認・任意保存用）
  if (body.action === 'snapNow') {
    var pfxN = String(body.prefix || '');
    if (SNAP_ENV_PREFIXES.indexOf(pfxN) < 0) return makeResponse('error: bad prefix');
    try { return makeResponse(snapCreate(pfxN, 'manual', String(body.label || ''))); }
    catch (erN) { return makeResponse('error: ' + erN.message); }
  }

  var lock = LockService.getScriptLock();
  var locked = false;
  try { lock.waitLock(25000); locked = true; } catch (le) {
    return makeResponse('error: lock_timeout');
  }
  try {
    var key = body.key;
    var value = body.value;
    if (!key) return makeResponse('error: no key');

    var sheet = getSheet();
    var now = new Date().toLocaleString('ja-JP');
    var str = (value === null || value === undefined) ? '' : String(value);

    // Write new data FIRST, then clean up old chunk rows last.
    // This way, if anything fails midway, the old data is still readable.
    if (str.length <= BIG_THRESHOLD) {
      // small value: keep in the sheet
      writeRow(sheet, key, str, now);
    } else {
      // big value: store in Drive (must succeed), then mark the sheet
      driveWrite(key, str);
      writeRow(sheet, key, FILE_MARKER, now);
    }

    // legacy cleanup only after the new value is safely written
    deleteChunks(sheet, key);

    invalidateCache(key);
    return makeResponse('ok');
  } catch (err) {
    return makeResponse('error: ' + err.message);
  } finally {
    if (locked) lock.releaseLock();
  }
}

function dailyBackup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var source = getSheet();
  var now = new Date();
  var y = now.getFullYear();
  var m = String(now.getMonth() + 1).padStart(2, '0');
  var d = String(now.getDate()).padStart(2, '0');
  var sheetName = BACKUP_SHEET_PREFIX + y + m + d;
  var existing = ss.getSheetByName(sheetName);
  if (existing) ss.deleteSheet(existing);
  var copy = source.copyTo(ss);
  copy.setName(sheetName);
  ss.moveActiveSheet(ss.getSheets().length);
  cleanupOldBackups();
  Logger.log('backup done: ' + sheetName);
}

function cleanupOldBackups() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  var now = new Date();
  var limitMs = BACKUP_KEEP_DAYS * 24 * 60 * 60 * 1000;
  sheets.forEach(function(sheet) {
    var name = sheet.getName();
    if (name.indexOf(BACKUP_SHEET_PREFIX) !== 0) return;
    var dateStr = name.replace(BACKUP_SHEET_PREFIX, '');
    if (dateStr.length !== 8) return;
    var y = parseInt(dateStr.substring(0, 4), 10);
    var m = parseInt(dateStr.substring(4, 6), 10) - 1;
    var d = parseInt(dateStr.substring(6, 8), 10);
    var sheetDate = new Date(y, m, d);
    if (now - sheetDate > limitMs) {
      ss.deleteSheet(sheet);
      Logger.log('deleted old backup: ' + name);
    }
  });
}

function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'dailyBackup') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('dailyBackup')
    .timeBased()
    .everyDays(1)
    .atHour(2)
    .create();
  Logger.log('trigger registered');
}

// One-time: restore loaner data from the latest backup sheet, if it was lost.
function restoreFromLatestBackup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  var backups = [];
  sheets.forEach(function(s){ if (s.getName().indexOf(BACKUP_SHEET_PREFIX) === 0) backups.push(s.getName()); });
  backups.sort();
  if (backups.length === 0) { Logger.log('no backup found'); return; }
  var latest = backups[backups.length - 1];
  Logger.log('using backup: ' + latest);
  var bsheet = ss.getSheetByName(latest);
  var bdata = bsheet.getDataRange().getValues();
  var target = ['hub-v8-honten-lres', 'hub-v8-sanda-lres'];
  var sheet = getSheet();
  target.forEach(function(tkey){
    for (var i = 1; i < bdata.length; i++) {
      if (bdata[i][0] === tkey) {
        var val = String(bdata[i][1]);
        writeRow(sheet, tkey, val, new Date().toLocaleString('ja-JP'));
        invalidateCache(tkey);
        Logger.log('restored ' + tkey + ' (length=' + val.length + ')');
        break;
      }
    }
  });
}

// Move ALL big values currently in the sheet to Drive, so the sheet stays light.
// Run this once manually from the GAS editor.
function migrateAllBigToDrive() {
  var sheet = getSheet();
  var last = sheet.getLastRow();
  if (last < 2) { Logger.log('empty'); return; }
  var keys = sheet.getRange(1, 1, last, 1).getValues();
  var moved = 0;
  for (var i = 1; i < keys.length; i++) {
    var k = keys[i][0];
    if (!k) continue;
    if (String(k).indexOf('__chunk') >= 0) continue;        // skip legacy chunk rows
    var v = String(sheet.getRange(i + 1, 2).getValue());
    if (v === FILE_MARKER) continue;                         // already in Drive
    if (v.indexOf(CHUNK_MARKER) === 0) continue;             // legacy chunked (read elsewhere)
    if (v.length > BIG_THRESHOLD) {
      driveWrite(k, v);
      sheet.getRange(i + 1, 2).setValue(FILE_MARKER);
      invalidateCache(k);
      Logger.log('moved to Drive: ' + k + ' len=' + v.length);
      moved++;
    }
  }
  Logger.log('migrateAllBigToDrive done, moved=' + moved);
}

// Restore loaner data from the backup that has the MOST honten loaner data
// (the latest backup may be from after the data was lost).
function restoreLoanerBestBackup() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheets = ss.getSheets();
  var best = null, bestLen = -1;
  sheets.forEach(function(s) {
    if (s.getName().indexOf(BACKUP_SHEET_PREFIX) !== 0) return;
    var d = s.getDataRange().getValues();
    var hl = 0;
    for (var i = 1; i < d.length; i++) {
      if (d[i][0] === 'hub-v8-honten-lres') hl = String(d[i][1]).length;
    }
    Logger.log(s.getName() + ' honten-lres=' + hl);
    if (hl > bestLen) { bestLen = hl; best = s.getName(); }
  });
  if (!best) { Logger.log('no backup found'); return; }
  Logger.log('BEST backup = ' + best + ' (honten-lres len=' + bestLen + ')');
  var bd = ss.getSheetByName(best).getDataRange().getValues();
  var sheet = getSheet();
  ['hub-v8-honten-lres', 'hub-v8-sanda-lres'].forEach(function(tk) {
    for (var i = 1; i < bd.length; i++) {
      if (bd[i][0] === tk) {
        var val = String(bd[i][1]);
        writeRow(sheet, tk, val, new Date().toLocaleString('ja-JP'));
        invalidateCache(tk);
        Logger.log('restored ' + tk + ' len=' + val.length);
        break;
      }
    }
  });
}

// ============================================================
//  v10: 時点スナップショット & 復旧（Snapshot / Restore）
// ============================================================
var SNAP_FOLDER = 'hubdata_snapshots';
var SNAP_INTRADAY_KEEP_HOURS = 48;                    // 30分ごと(auto/manual/pre-restore)を残す時間＝2日
var SNAP_DAILY_KEEP_DAYS = 90;                        // 毎朝2時(daily)を残す日数
var SNAP_ENV_PREFIXES = ['hub-v8-', 'hub-v8-dev-'];   // 本番・DEVを別々にスナップショット
var SNAP_EXTRA_KEYS = ['schedRestrictions'];          // プレフィックス無しの共有キー（本番の保存に明示的に含める）

function snapFolder() {
  var it = DriveApp.getFoldersByName(SNAP_FOLDER);
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder(SNAP_FOLDER);
}

// prefix配下の保存対象キー一覧。full=falseは30分ごと用（大きい顧客ファイル cf-* を除外して軽くする）。
// チャンク行・indexキー自身・別envキーは常に除外。
function snapTargetKeys(sheet, prefix, full) {
  var last = sheet.getLastRow();
  var out = [];
  if (last >= 1) {
    var col = sheet.getRange(1, 1, last, 1).getValues();
    for (var i = 1; i < col.length; i++) {
      var k = col[i][0];
      if (!k) continue; k = String(k);
      if (k.indexOf(prefix) !== 0) continue;
      if (prefix === 'hub-v8-' && k.indexOf('hub-v8-dev-') === 0) continue; // 本番にDEVキーを混ぜない
      if (k.indexOf('__chunk') >= 0) continue;             // レガシー分割行は除外（indexから辿るので不要）
      if (k === prefix + 'snap-index') continue;           // インデックス自身は保存しない
      if (!full && k.indexOf(prefix + 'cf-') === 0) continue; // 大きい顧客ファイルは日次(full)のみ
      out.push(k);
    }
  }
  if (prefix === 'hub-v8-') {
    for (var e = 0; e < SNAP_EXTRA_KEYS.length; e++) {
      if (out.indexOf(SNAP_EXTRA_KEYS[e]) < 0) out.push(SNAP_EXTRA_KEYS[e]);
    }
  }
  return out;
}

// プレビュー用の要約件数（車検・整備・代車/レンタカー・メモ）。壊れていても0を返すだけ（表示用なので実害なし）。
function snapSummary(getVal, prefix) {
  function j(base) { try { var v = getVal(prefix + base); return (v && v !== 'null') ? JSON.parse(v) : null; } catch (e) { return null; } }
  function inspN(o) { var n = 0; if (o) for (var d in o) { var a = o[d] || []; for (var i = 0; i < a.length; i++) { var r = a[i]; if (r && r.name && r.bookingStatus !== 'cancelled') n++; } } return n; }
  function schedN(o) { var n = 0; if (o) for (var d in o) { var day = o[d] || {}; for (var s in day) { if (day[s] && day[s].name) n++; } } return n; }
  function objN(o) { var n = 0; if (o) for (var c in o) { var b = o[c] || {}; for (var kk in b) n++; } return n; } // lres/rres: {carId:{key:予約}}
  function memoN(o) { var n = 0; if (o) for (var d in o) { n += (o[d] || []).length; } return n; }
  return {
    insp: inspN(j('insp')),
    sched: schedN(j('honten-sched')) + schedN(j('sanda-sched')),
    loaner: objN(j('honten-lres')) + objN(j('sanda-lres')) + objN(j('rres')),
    memo: memoN(j('honten-memo')) + memoN(j('sanda-memo'))
  };
}

// 1プレフィックス分のスナップショットを作成し、indexへ1件追加する。作成したファイル名を返す。
function snapCreate(prefix, kind, label) {
  var sheet = getSheet();
  var cache = CacheService.getScriptCache();
  var full = (kind === 'daily');
  var keys = snapTargetKeys(sheet, prefix, full);
  var data = {};
  for (var i = 0; i < keys.length; i++) {
    data[keys[i]] = readOneValue(sheet, cache, keys[i], -2); // Drive実体まで解決した実値
  }
  var now = new Date();
  var stamp = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  var getVal = function(k) { return data.hasOwnProperty(k) ? data[k] : null; };
  var summary = snapSummary(getVal, prefix);
  var payload = { ts: now.getTime(), tsText: now.toLocaleString('ja-JP'), kind: kind, label: label || '', prefix: prefix, summary: summary, keys: data };
  var fname = prefix + stamp + '_' + kind + '.json';
  snapFolder().createFile(fname, JSON.stringify(payload), 'application/json');

  // index更新（プレフィックス別の通常キーとして保存。中身(keys)は含めず、要約とファイル名だけ）
  var idxKey = prefix + 'snap-index';
  var idxRaw = readOneValue(sheet, cache, idxKey, -2);
  var idx;
  try { idx = (idxRaw && idxRaw !== 'null') ? JSON.parse(idxRaw) : []; } catch (e) { idx = []; }
  idx.unshift({ file: fname, ts: payload.ts, tsText: payload.tsText, kind: kind, label: payload.label, summary: summary });
  idx = snapPrune(idx);
  var idxStr = JSON.stringify(idx);
  var nowStr = now.toLocaleString('ja-JP');
  if (idxStr.length <= BIG_THRESHOLD) { writeRow(sheet, idxKey, idxStr, nowStr); }
  else { driveWrite(idxKey, idxStr); writeRow(sheet, idxKey, FILE_MARKER, nowStr); }
  invalidateCache(idxKey);
  return fname;
}

// 保持ルールでindexを間引き、期限切れのDriveファイルを削除する。残すindexを返す。
function snapPrune(idx) {
  var now = Date.now();
  var folder = snapFolder();
  var keep = [];
  for (var i = 0; i < idx.length; i++) {
    var en = idx[i];
    var age = now - (en.ts || 0);
    var limit = (en.kind === 'daily') ? SNAP_DAILY_KEEP_DAYS * 24 * 3600 * 1000 : SNAP_INTRADAY_KEEP_HOURS * 3600 * 1000;
    if (age <= limit) { keep.push(en); }
    else { try { var it = folder.getFilesByName(en.file); if (it.hasNext()) it.next().setTrashed(true); } catch (ex) {} }
  }
  return keep;
}

// 指定した時点に全データを戻す。実行直前に現状も pre-restore として保存（やり直し用）。
function snapRestore(prefix, fname) {
  var folder = snapFolder();
  var it = folder.getFilesByName(fname);
  if (!it.hasNext()) return 'error: snapshot not found';
  try { snapCreate(prefix, 'pre-restore', '復旧直前の自動保存'); } catch (e) {} // 失敗しても復旧自体は続行
  var payload;
  try { payload = JSON.parse(it.next().getBlob().getDataAsString()); } catch (pe) { return 'error: broken snapshot'; }
  if (!payload || payload.prefix !== prefix || !payload.keys) return 'error: prefix mismatch';
  var sheet = getSheet();
  var now = new Date().toLocaleString('ja-JP');
  var keys = Object.keys(payload.keys);
  var restored = 0;
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    var v = payload.keys[k];
    var str = (v === null || v === undefined) ? '' : String(v);
    if (str.length <= BIG_THRESHOLD) { writeRow(sheet, k, str, now); }
    else { driveWrite(k, str); writeRow(sheet, k, FILE_MARKER, now); }
    deleteChunks(sheet, k);
    invalidateCache(k);
    restored++;
  }
  return 'ok: restored ' + restored + ' keys';
}

// 30分ごとトリガーの本体（本番・DEV両方）
function intradaySnapshot() {
  for (var i = 0; i < SNAP_ENV_PREFIXES.length; i++) {
    try { snapCreate(SNAP_ENV_PREFIXES[i], 'auto', ''); }
    catch (e) { Logger.log('intraday snap fail ' + SNAP_ENV_PREFIXES[i] + ': ' + e.message); }
  }
}

// 毎朝2時トリガーの本体（大きい顧客ファイルも含めた完全スナップショット）
function dailySnapshot() {
  for (var i = 0; i < SNAP_ENV_PREFIXES.length; i++) {
    try { snapCreate(SNAP_ENV_PREFIXES[i], 'daily', ''); }
    catch (e) { Logger.log('daily snap fail ' + SNAP_ENV_PREFIXES[i] + ': ' + e.message); }
  }
}

// 初回1回だけGASエディタから実行：スナップショット用トリガーを登録（既存の dailyBackup トリガーはそのまま）
function setupSnapshotTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    var f = t.getHandlerFunction();
    if (f === 'intradaySnapshot' || f === 'dailySnapshot') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('intradaySnapshot').timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger('dailySnapshot').timeBased().everyDays(1).atHour(2).create();
  Logger.log('snapshot triggers registered');
}

// 動作確認用：DEVプレフィックスで手動スナップショット→一覧を確認（GASエディタから実行）
function testSnapshotDev() {
  var f = snapCreate('hub-v8-dev-', 'manual', 'test');
  Logger.log('created: ' + f);
  var sheet = getSheet();
  Logger.log('index: ' + readOneValue(sheet, CacheService.getScriptCache(), 'hub-v8-dev-snap-index', -2));
}
