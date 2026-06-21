# -*- coding: utf-8 -*-
"""
Thai National ID Card local agent — พรรคประชาชน
อ่านบัตรประชาชนผ่านเครื่องอ่าน PC/SC แล้วเปิด HTTP server บน 127.0.0.1
ให้เว็บแอป (Google Apps Script) เรียกดึงข้อมูลได้

ใช้งาน:
    pip install pyscard
    python idcard_agent.py
แล้วเปิดเว็บแอป กดปุ่ม "อ่านบัตรประชาชน"

Endpoints:
    GET /status  -> {ok, readerConnected, cardPresent, reader}
    GET /read    -> {ok, data:{cid,title,firstName,lastName,fullName,fullNameEN,
                                dob,gender,address:{line1,subdistrict,district,province,postal},
                                issueDate,expireDate,issuer}}
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = '127.0.0.1'
PORT = 8765

# ---- field map (APDU command, length) ----
APDU_SELECT = [0x00, 0xA4, 0x04, 0x00, 0x08, 0xA0, 0x00, 0x00, 0x00, 0x54, 0x48, 0x00, 0x01]

CMD_CID        = [0x80, 0xB0, 0x00, 0x04, 0x02, 0x00, 0x0D]
CMD_NAME_TH    = [0x80, 0xB0, 0x00, 0x11, 0x02, 0x00, 0x64]
CMD_NAME_EN    = [0x80, 0xB0, 0x00, 0x75, 0x02, 0x00, 0x64]
CMD_DOB        = [0x80, 0xB0, 0x00, 0xD9, 0x02, 0x00, 0x08]
CMD_GENDER     = [0x80, 0xB0, 0x00, 0xE1, 0x02, 0x00, 0x01]
CMD_ISSUER     = [0x80, 0xB0, 0x00, 0xF6, 0x02, 0x00, 0x64]
CMD_ISSUE_DATE = [0x80, 0xB0, 0x01, 0x67, 0x02, 0x00, 0x08]
CMD_EXPIRE     = [0x80, 0xB0, 0x01, 0x6F, 0x02, 0x00, 0x08]
CMD_ADDRESS    = [0x80, 0xB0, 0x15, 0x79, 0x02, 0x00, 0x64]


def decode_th(data):
    """แปลง byte จากบัตร (TIS-620) เป็น string"""
    try:
        return bytes(data).decode('tis-620').strip()
    except Exception:
        try:
            return bytes(data).decode('cp874').strip()
        except Exception:
            return bytes(data).decode('latin-1').strip()


def thai_date(raw):
    """แปลง YYYYMMDD (พ.ศ.) -> 'd month yyyy(พ.ศ.)' ; คืน '' ถ้าว่าง"""
    s = (raw or '').strip()
    if len(s) != 8 or not s.isdigit():
        return s
    months = ['', 'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
              'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม']
    y, m, d = s[0:4], int(s[4:6]), int(s[6:8])
    if m < 1 or m > 12:
        return s
    return '%d %s %s' % (d, months[m], y)


def parse_name(raw):
    """'นาย#สมชาย##ใจดี' -> (title, first, last, full)"""
    parts = [p for p in (raw or '').split('#')]
    title = parts[0].strip() if len(parts) > 0 else ''
    first = parts[1].strip() if len(parts) > 1 else ''
    last  = parts[3].strip() if len(parts) > 3 else (parts[2].strip() if len(parts) > 2 else '')
    full = ' '.join([x for x in [title + first if title and first else (title or first), last] if x]).strip()
    if title and first:
        full = (title + first + ' ' + last).strip()
    else:
        full = ' '.join([x for x in [title, first, last] if x]).strip()
    return title, first, last, full


def strip_prefix(s, prefixes):
    s = (s or '').strip()
    for p in prefixes:
        if s.startswith(p):
            return s[len(p):].strip()
    return s


def parse_address(raw):
    """
    address บนบัตรคั่นด้วย '#':
    [เลขที่, หมู่ที่, ตรอก, ซอย, ถนน, ตำบล/แขวง, อำเภอ/เขต, จังหวัด]
    (ไม่มีรหัสไปรษณีย์บนบัตร)
    """
    parts = [p.strip() for p in (raw or '').split('#')]
    def g(i):
        return parts[i].strip() if i < len(parts) else ''
    house, moo, trok, soi, road = g(0), g(1), g(2), g(3), g(4)
    tambon, amphoe, changwat = g(5), g(6), g(7)

    # ตรอก (trok) ไม่มีช่องแยก — รวมเข้าซอยถ้าซอยว่าง
    soi_val = strip_prefix(soi, ['ซอย', 'ซ.'])
    if not soi_val:
        soi_val = strip_prefix(trok, ['ตรอก'])

    return {
        'houseNo':     strip_prefix(house, ['บ้านเลขที่', 'เลขที่']),
        'moo':         strip_prefix(moo, ['หมู่ที่', 'หมู่', 'ม.']),
        'village':     '',  # ไม่มีช่องแยกบนบัตร
        'soi':         soi_val,
        'road':        strip_prefix(road, ['ถนน', 'ถ.']),
        'subdistrict': strip_prefix(tambon, ['ตำบล', 'แขวง', 'ต.']),
        'district':    strip_prefix(amphoe, ['อำเภอ', 'เขต', 'อ.']),
        'province':    strip_prefix(changwat, ['จังหวัด', 'จ.']),
        'postal':      ''  # ไม่มีบนบัตร
    }


def get_response_prefix(atr):
    """เลือก GET RESPONSE ตาม ATR ของเครื่องอ่าน"""
    if len(atr) >= 2 and atr[0] == 0x3B and atr[1] == 0x67:
        return [0x00, 0xC0, 0x00, 0x01]
    return [0x00, 0xC0, 0x00, 0x00]


def read_field(connection, cmd, gr_prefix):
    """ส่ง APDU อ่าน field -> GET RESPONSE -> คืน raw bytes"""
    data, sw1, sw2 = connection.transmit(cmd)
    le = cmd[-1]
    data, sw1, sw2 = connection.transmit(gr_prefix + [le])
    return data


def read_card():
    from smartcard.System import readers
    from smartcard.util import toHexString  # noqa: F401

    rlist = readers()
    if not rlist:
        return {'ok': False, 'error': 'ไม่พบเครื่องอ่านบัตร — เสียบเครื่องอ่านแล้วลองใหม่'}

    reader = rlist[0]
    try:
        connection = reader.createConnection()
        connection.connect()
    except Exception as e:
        return {'ok': False, 'error': 'เชื่อมต่อบัตรไม่ได้ — เสียบบัตรให้แน่น (%s)' % e}

    try:
        atr = connection.getATR()
        gr = get_response_prefix(atr)

        # select applet
        connection.transmit(APDU_SELECT)

        cid        = decode_th(read_field(connection, CMD_CID, gr))
        name_th    = decode_th(read_field(connection, CMD_NAME_TH, gr))
        name_en    = decode_th(read_field(connection, CMD_NAME_EN, gr))
        dob        = decode_th(read_field(connection, CMD_DOB, gr))
        gender_raw = decode_th(read_field(connection, CMD_GENDER, gr))
        issuer     = decode_th(read_field(connection, CMD_ISSUER, gr))
        issue_date = decode_th(read_field(connection, CMD_ISSUE_DATE, gr))
        expire     = decode_th(read_field(connection, CMD_EXPIRE, gr))
        address    = decode_th(read_field(connection, CMD_ADDRESS, gr))

        title, first, last, full = parse_name(name_th)
        _, fe, le_, full_en = parse_name(name_en)

        return {
            'ok': True,
            'data': {
                'cid':        ''.join(ch for ch in cid if ch.isdigit()),
                'title':      title,
                'firstName':  first,
                'lastName':   last,
                'fullName':   full,
                'fullNameEN': full_en,
                'gender':     'ชาย' if gender_raw == '1' else ('หญิง' if gender_raw == '2' else gender_raw),
                'dob':        thai_date(dob),
                'issueDate':  thai_date(issue_date),
                'expireDate': thai_date(expire),
                'issuer':     issuer,
                'address':    parse_address(address)
            }
        }
    except Exception as e:
        return {'ok': False, 'error': 'อ่านข้อมูลบัตรไม่สำเร็จ: %s' % e}
    finally:
        try:
            connection.disconnect()
        except Exception:
            pass


def get_status():
    try:
        from smartcard.System import readers
    except Exception as e:
        return {'ok': False, 'error': 'ไม่ได้ติดตั้ง pyscard: %s' % e}
    try:
        rlist = readers()
    except Exception as e:
        return {'ok': False, 'error': str(e)}
    if not rlist:
        return {'ok': True, 'readerConnected': False, 'cardPresent': False, 'reader': None}
    reader = rlist[0]
    card_present = False
    try:
        conn = reader.createConnection()
        conn.connect()
        card_present = True
        conn.disconnect()
    except Exception:
        card_present = False
    return {'ok': True, 'readerConnected': True, 'cardPresent': card_present, 'reader': str(reader)}


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Private-Network', 'true')

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self._cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/status':
            self._json(get_status())
        elif path == '/read':
            self._json(read_card())
        elif path == '/':
            self._json({'ok': True, 'service': 'thai-idcard-agent', 'endpoints': ['/status', '/read']})
        else:
            self._json({'ok': False, 'error': 'not found'}, 404)

    def log_message(self, fmt, *args):
        sys.stderr.write('[agent] ' + (fmt % args) + '\n')


def main():
    try:
        import smartcard  # noqa: F401
    except Exception:
        print('!! ยังไม่ได้ติดตั้ง pyscard — รัน: pip install pyscard', file=sys.stderr)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print('Thai ID card agent running at http://%s:%d' % (HOST, PORT))
    print('เปิดเว็บแอปแล้วกดปุ่ม "อ่านบัตรประชาชน"  (Ctrl+C เพื่อหยุด)')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nstopped.')


if __name__ == '__main__':
    main()
