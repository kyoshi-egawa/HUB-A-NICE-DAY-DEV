// Hub a Nice Day - GAS server v9
// Big values are stored as Google Drive files (not spreadsheet cells),
// so the sheet stays small and every write is fast. Small values stay in the sheet.
// Backward compatible: still reads old single-cell and old __CHUNKED__ row data.

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

function doGet(e) {
  if (!e.parameter || e.parameter.apiKey !== HUB_API_KEY) {
    return makeResponse('unauthorized');
  }
  try {
    var key = e.parameter && e.parameter.key;
    if (!key) return makeResponse('null');

    var cache = CacheService.getScriptCache();
    var cached = cache.get(key);
    if (cached !== null && cached.indexOf(CHUNK_MARKER) !== 0 && cached !== FILE_MARKER) {
      return makeResponse(cached);
    }

    var sheet = getSheet();
    var row = findRow(sheet, key);
    if (row === -1) return makeResponse('null');
    var value = sheet.getRange(row, 2).getValue();
    value = (value === '' || value === null || value === undefined) ? 'null' : String(value);

    // value lives in a Drive file
    if (value === FILE_MARKER) {
      var c = driveRead(key);
      if (c === null || c === '') c = 'null';
      try { if (c.length < 90000) cache.put(key, c, 60); } catch (ce) {}
      return makeResponse(c);
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
      return makeResponse(result);
    }

    try { cache.put(key, value, 60); } catch (ce) {}
    return makeResponse(value);
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
