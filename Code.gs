// ============================================================
//  ระบบออกใบสำคัญรับเงินชั่วคราว — พรรคประชาชน
//  Phase 1: GAS Backend
// ============================================================

var SHEET_ID   = '1x0WLlobQk7nx_Pf-iQhnC03jwnkH5sjdmdpxVRTl3Mk';
var SHEET_NAME = 'ใบเสร็จ';
var ALLOWED_DOMAIN = 'peoplesparty.or.th';

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

  // สร้าง header ถ้ายังไม่มี
  if (sheet.getLastRow() === 0) {
    sheet.appendRow([
      'timestamp', 'docNo', 'bookNo', 'date',
      'receiverName', 'receiverId', 'address',
      'items', 'total', 'payMethod', 'membershipPeriod',
      'signerName', 'signerPosition', 'savedBy'
    ]);
  }

  var now = new Date();
  sheet.appendRow([
    now,
    payload.docNo        || '',
    payload.bookNo       || '',
    payload.date         || '',
    payload.receiverName || '',
    payload.receiverId   || '',
    payload.address      || '',
    typeof payload.items === 'string' ? payload.items : JSON.stringify(payload.items || []),
    Number(payload.total) || 0,
    payload.payMethod        || '',
    payload.membershipPeriod || '',
    payload.signerName       || '',
    payload.signerPosition   || '',
    email
  ]);

  return { ok: true, savedAt: now.toISOString() };
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
  var numCols  = 14;
  var range    = sheet.getRange(startRow, 1, n, numCols);
  var values   = range.getValues();

  // คืนค่าล่าสุดก่อน (reverse) และ map ให้เป็น object
  return values.reverse().map(function(row) {
    return {
      timestamp:        row[0]  ? Utilities.formatDate(new Date(row[0]), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm') : '',
      docNo:            row[1]  || '',
      bookNo:           row[2]  || '',
      date:             row[3]  || '',
      receiverName:     row[4]  || '',
      receiverId:       row[5]  || '',
      address:          row[6]  || '',
      items:            row[7]  || '[]',
      total:            row[8]  || 0,
      payMethod:        row[9]  || '',
      membershipPeriod: row[10] || '',
      signerName:       row[11] || '',
      signerPosition:   row[12] || '',
      savedBy:          row[13] || ''
    };
  });
}

// ------------------------------------------------------------
// helper
// ------------------------------------------------------------
function getSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
  }
  return sheet;
}
