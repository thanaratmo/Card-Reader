// ============================================================
//  ระบบออกใบสำคัญรับเงินชั่วคราว — พรรคประชาชน
//  Phase 1: GAS Backend
// ============================================================

var SHEET_ID   = '1x0WLlobQk7nx_Pf-iQhnC03jwnkH5sjdmdpxVRTl3Mk';
var SHEET_NAME = 'ใบเสร็จ';
var ALLOWED_DOMAIN = 'peoplesparty.or.th';
var SLIP_FOLDER_ID = '1TU3rNtADOUPVSaK73nHifD4Kv1TH3J7T';  // โฟลเดอร์เก็บรูปสลิป

// ------------------------------------------------------------
// Access control
// ------------------------------------------------------------
function checkAccess_() {
  var email = Session.getActiveUser().getEmail();
  if (!email || !email.endsWith('@' + ALLOWED_DOMAIN)) {
    throw new Error('Access denied: กรุณาล็อกอินด้วยบัญชี @' + ALLOWED_DOMAIN);
  }
  return email;
}

// ------------------------------------------------------------
// doGet — serve web app (HTML จะเพิ่มใน Phase 2)
// ------------------------------------------------------------
function doGet(e) {
  checkAccess_();
  return HtmlService
    .createTemplateFromFile('Index')
    .evaluate()
    .setTitle('ระบบออกใบสำคัญรับเงินชั่วคราว — พรรคประชาชน')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ------------------------------------------------------------
// include — ฝังไฟล์ HTML อื่น (CSS / JS / fonts) เข้า Index
// ------------------------------------------------------------
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ------------------------------------------------------------
// getInitData — ข้อมูลเริ่มต้นตอนเปิดแอป (เลขเอกสารถัดไป + ประวัติ)
// ------------------------------------------------------------
function getInitData() {
  var email = checkAccess_();
  return {
    email:     email,
    nextDocNo: getNextDocNo(),
    today:     Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd'),
    recent:    getRecentRows(8)
  };
}

// ------------------------------------------------------------
// getNextDocNo — สร้างเลขเอกสารต่อเนื่องจาก Sheet
// ------------------------------------------------------------
function getNextDocNo() {
  checkAccess_();
  var sheet = getSheet_();
  var lastRow = sheet.getLastRow();
  // แถวแรกเป็น header → running number = lastRow (เริ่มที่ 1 เมื่อยังไม่มีข้อมูล)
  var runNum = Math.max(lastRow, 1);

  var now = new Date();
  var be  = now.getFullYear() + 543;
  var yy  = String(be).slice(-2);
  var mm  = String(now.getMonth() + 1).padStart(2, '0');
  var seq = String(runNum).padStart(5, '0');

  return 'PPLE' + yy + '/' + mm + '/' + seq;
}

// ------------------------------------------------------------
// saveRow — บันทึกข้อมูลลง Sheet
//   payload = {
//     docNo, bookNo, date, receiverName, receiverId,
//     address,          // string ที่อยู่รวม
//     items,            // JSON string ของ [{desc, amount}]
//     total,            // number
//     payMethod,        // 'cash' | 'transfer'
//     membershipPeriod, // 'yearly' | 'lifetime'
//     signerName,
//     signerPosition
//   }
// ------------------------------------------------------------
function saveRow(payload) {
  var email = checkAccess_();
  var sheet = getSheet_();
  ensureHeader_(sheet);

  var now = new Date();

  // ---- บันทึกรูปสลิปลง Drive (ตั้งชื่อไฟล์ = เลขบัตรประชาชน) ----
  var blob = null, slipUrlCell = '', slipNote = '';
  if (payload.slip) {
    slipNote = 'แนบสลิปแล้ว';
    try {
      var b64  = String(payload.slip).replace(/^data:image\/\w+;base64,/, '');
      var cid  = String(payload.receiverId || '').replace(/\D/g, '');
      var fname = (cid || payload.docNo || 'slip') + '.jpg';
      blob = Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', fname);
      var folder = DriveApp.getFolderById(SLIP_FOLDER_ID);
      var file   = folder.createFile(blob);
      slipUrlCell = '=HYPERLINK("' + file.getUrl() + '","ดูสลิป")';
    } catch (err) {
      slipNote = 'แนบสลิป (อัปโหลด Drive ไม่สำเร็จ)';
    }
  }

  sheet.appendRow([
    now,
    payload.docNo        || '',
    payload.bookNo       || '',
    payload.date         || '',
    payload.receiverName || '',
    payload.receiverId   || '',
    payload.houseNo      || '',
    payload.moo          || '',
    payload.village      || '',
    payload.soi          || '',
    payload.road         || '',
    payload.subdistrict  || '',
    payload.district     || '',
    payload.province     || '',
    payload.postal       || '',
    typeof payload.items === 'string' ? payload.items : JSON.stringify(payload.items || []),
    Number(payload.total) || 0,
    payload.payMethod        || '',
    payload.membershipPeriod || '',
    payload.signerName       || '',
    payload.signerPosition   || '',
    email,
    slipNote,
    slipUrlCell
  ]);

  return { ok: true, savedAt: now.toISOString() };
}

// ------------------------------------------------------------
// exportExcel — ส่งออกข้อมูลทั้งหมดเป็นไฟล์ .xlsx (ยกเว้นคอลัมน์ slip, slipUrl)
// ------------------------------------------------------------
function exportExcel() {
  checkAccess_();
  var sheet  = getSheet_();
  var values = sheet.getDataRange().getValues();
  if (!values.length) return { name: '', b64: '' };

  var header = values[0];
  // คอลัมน์ที่จะตัดออก
  var dropNames = ['slip', 'slipUrl'];
  var keep = [];
  for (var i = 0; i < header.length; i++) {
    if (dropNames.indexOf(header[i]) === -1) keep.push(i);
  }
  var filtered = values.map(function (row) {
    return keep.map(function (i) { return i < row.length ? row[i] : ''; });
  });

  // สร้างสเปรดชีตชั่วคราว → export เป็น xlsx → ลบทิ้ง
  var tmp = SpreadsheetApp.create('export_tmp_' + Date.now());
  var ts  = tmp.getSheets()[0];
  ts.getRange(1, 1, filtered.length, filtered[0].length).setValues(filtered);
  SpreadsheetApp.flush();

  var id    = tmp.getId();
  var url   = 'https://docs.google.com/spreadsheets/d/' + id + '/export?format=xlsx';
  var token = ScriptApp.getOAuthToken();
  var resp  = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  var b64   = Utilities.base64Encode(resp.getBlob().getBytes());

  DriveApp.getFileById(id).setTrashed(true);

  var name = 'ใบเสร็จพรรคประชาชน_' +
             Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd_HHmm') + '.xlsx';
  return { name: name, b64: b64 };
}

// ------------------------------------------------------------
// getRecentRows — ดึง n แถวล่าสุด (ไม่รวม header)
// ------------------------------------------------------------
function getRecentRows(n) {
  checkAccess_();
  var sheet   = getSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];   // มีแค่ header หรือว่างเปล่า

  n = Math.min(n || 8, lastRow - 1);
  var startRow = lastRow - n + 1;
  var numCols  = HEADERS.length;
  var range    = sheet.getRange(startRow, 1, n, numCols);
  var values   = range.getValues();

  // คืนค่าล่าสุดก่อน (reverse) และ map ให้เป็น object
  return values.reverse().map(function(row) {
    return {
      timestamp:        row[0]  ? Utilities.formatDate(new Date(row[0]), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm') : '',
      docNo:            row[1]  || '',
      receiverName:     row[4]  || '',
      total:            row[16] || 0
    };
  });
}

// ------------------------------------------------------------
// header / sheet helpers
// ------------------------------------------------------------
var HEADERS = [
  'timestamp', 'docNo', 'bookNo', 'date',
  'receiverName', 'receiverId',
  'houseNo', 'moo', 'village', 'soi', 'road',
  'subdistrict', 'district', 'province', 'postal',
  'items', 'total', 'payMethod', 'membershipPeriod',
  'signerName', 'signerPosition', 'savedBy', 'slip', 'slipUrl'
];

function ensureHeader_(sheet) {
  // เขียน/แก้แถวหัวตารางให้ตรงกับ HEADERS เสมอ
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    return;
  }
  var current = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  var same = current.length === HEADERS.length && HEADERS.every(function(h, i) { return current[i] === h; });
  if (!same) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
}

// รันครั้งเดียวจาก editor เพื่อ "ล้างข้อมูลทดสอบเก่า + ตั้งหัวคอลัมน์ใหม่"
function setupSheet() {
  var sheet = getSheet_();
  removeImages_(sheet);
  sheet.clear();
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  return 'reset done — ' + HEADERS.length + ' columns';
}

// รันจาก editor เพื่อ "ลบรูปสลิปที่ฝังในชีตทั้งหมด" (เช่น รูปทดสอบ)
function clearSlipImages() {
  var sheet = getSheet_();
  var n = removeImages_(sheet);
  return 'removed ' + n + ' images';
}

function removeImages_(sheet) {
  var imgs = sheet.getImages();
  imgs.forEach(function (im) { im.remove(); });
  return imgs.length;
}

function getSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  return sheet;
}
