/* 내 별점 지도 — 구글 시트 동기화 서버 (Google Apps Script)
   이 파일 내용을 전부 복사해서 스프레드시트의 "확장 프로그램 → Apps Script" 편집기에 붙여넣고,
   "배포 → 새 배포 → 웹 앱 (실행: 나, 액세스: 모든 사용자)"로 배포하면 끝이에요.
   나온 웹 앱 URL(…/exec)을 앱 설정의 "동기화 주소"에 넣으면 돼요.

   시트에는 식당 한 줄씩 사람이 보기 좋은 열(이름·주소·점수·평균·메모…)과 원본 json 열이 생겨요.
   시트를 직접 고치지는 마세요 — 다음 동기화 때 json 열 기준으로 다시 써져요. */

const SHEET_NAME = '식당';   // 데이터가 들어갈 시트 탭 이름 (없으면 만들어요)
const TOKEN = '';           // 선택: 비밀 코드. 넣으면 앱 설정에도 같은 코드를 넣어야 해요
const SHEET_ID = '';        // 보통 비워 둬요 (이 스크립트가 붙어 있는 스프레드시트를 써요)

// ===== 합치는 규칙 — sync/merge.js 와 똑같아요. 한쪽을 고치면 다른 쪽도 고쳐요 =====
const STR_FIELDS = ['id', 'kakaoId', 'name', 'category', 'memo', 'address', 'phone', 'placeUrl', 'visitedAt'];

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function keyOf(p) { return p.kakaoId ? 'k:' + p.kakaoId : 'i:' + p.id; }
function valid(p) {
  return !!p && typeof p === 'object' && !!(p.id || p.kakaoId)
    && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));
}
function sanitize(p) {
  const out = {};
  for (const k of STR_FIELDS) out[k] = p[k] == null ? '' : String(p[k]).slice(0, k === 'memo' ? 4000 : 400);
  out.lat = num(p.lat, 0); out.lng = num(p.lng, 0);
  out.ratings = {}; out.ratedAt = {};
  if (p.ratings && typeof p.ratings === 'object') {
    for (const n of Object.keys(p.ratings)) {
      const x = num(p.ratings[n], null), name = String(n).trim();
      if (name && x != null && x >= 1 && x <= 5) out.ratings[name] = Math.round(x * 2) / 2;
    }
  }
  if (p.ratedAt && typeof p.ratedAt === 'object') {
    for (const n of Object.keys(p.ratedAt)) {
      const x = num(p.ratedAt[n], 0), name = String(n).trim();
      if (name && x > 0) out.ratedAt[name] = x;
    }
  }
  out.createdAt = num(p.createdAt, 0) || num(p.updatedAt, 0) || Date.now();
  out.updatedAt = num(p.updatedAt, 0) || out.createdAt;
  out.deleted = !!p.deleted;
  return out;
}
function mergeRecord(a, b) {
  const ua = a.updatedAt || 0, ub = b.updatedAt || 0;
  const aWins = ua > ub || (ua === ub && String(a.id) <= String(b.id));
  const w = aWins ? a : b, l = aWins ? b : a;
  const out = Object.assign({}, l, w);
  if (!w.kakaoId && l.kakaoId) { out.kakaoId = l.kakaoId; out.placeUrl = l.placeUrl || w.placeUrl || ''; }
  const ratings = {}, ratedAt = {};
  const names = {};
  for (const src of [a.ratings, a.ratedAt, b.ratings, b.ratedAt]) if (src) for (const n of Object.keys(src)) names[n] = true;
  for (const n of Object.keys(names)) {
    const ta = (a.ratedAt && a.ratedAt[n]) || 0, tb = (b.ratedAt && b.ratedAt[n]) || 0;
    const va = a.ratings ? a.ratings[n] : undefined, vb = b.ratings ? b.ratings[n] : undefined;
    let v;
    if (ta > tb) v = va;
    else if (tb > ta) v = vb;
    else v = (va != null && vb != null) ? (w.ratings ? w.ratings[n] : undefined) : (va != null ? va : vb);
    if (v != null) ratings[n] = v;
    if (Math.max(ta, tb) > 0) ratedAt[n] = Math.max(ta, tb);
  }
  out.ratings = ratings; out.ratedAt = ratedAt;
  out.id = String(a.id) <= String(b.id) ? a.id : b.id;
  const ca = a.createdAt || Infinity, cb = b.createdAt || Infinity;
  out.createdAt = Math.min(ca, cb) === Infinity ? Math.max(ua, ub) : Math.min(ca, cb);
  out.updatedAt = Math.max(ua, ub);
  out.deleted = !!w.deleted;
  return out;
}
function mergeSets(base, incoming) {
  const byKey = new Map();
  const put = (p) => {
    const k = keyOf(p);
    const cur = byKey.get(k);
    byKey.set(k, cur ? mergeRecord(cur, p) : p);
  };
  for (const p of base) put(p);
  for (const p of incoming) put(p);
  return Array.from(byKey.values());
}

// ===== 웹 앱 =====
// 데이터가 바뀔 때마다 올라가는 번호(ver). 폰은 켜져 있는 동안 이 번호만 가볍게 물어보다가, 바뀌면 전체를 받아 가요.
const VER_KEY = 'starmap_ver';
function getVer_() {
  return CacheService.getScriptCache().get(VER_KEY) || PropertiesService.getScriptProperties().getProperty(VER_KEY) || '0';
}
function bumpVer_() {
  const v = String(Math.max(Date.now(), (Number(getVer_()) || 0) + 1)); // 같은 밀리초에 두 번 바뀌어도 항상 커지게
  CacheService.getScriptCache().put(VER_KEY, v, 21600);
  PropertiesService.getScriptProperties().setProperty(VER_KEY, v);
  return v;
}

// 브라우저로 URL을 열면 (GET) 연결 확인용 JSON이 보여요. ?op=ver 는 번호만 돌려줘요 (시트를 읽지 않아 빠름).
function doGet(e) {
  try {
    const op = e && e.parameter && e.parameter.op;
    if (op === 'ver') return out_({ ok: true, ver: getVer_(), time: Date.now() });
    const all = loadAll_(sheet_());
    return out_({ ok: true, app: 'starmap-sync', places: all.filter((p) => !p.deleted).length, ver: getVer_(), time: Date.now() });
  } catch (err) {
    return out_({ ok: false, error: String((err && err.message) || err) });
  }
}

// 앱은 POST 로 자기 데이터 전부를 보내고, 합쳐진 전체를 받아 가요.
function doPost(e) {
  let body;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return out_({ ok: false, error: 'bad-json' }); }
  if (TOKEN && String(body.token || '') !== TOKEN) return out_({ ok: false, error: 'token' });
  if (body.op === 'ping') return out_({ ok: true, app: 'starmap-sync', ver: getVer_(), time: Date.now() });
  if (body.op === 'ver') return out_({ ok: true, ver: getVer_(), time: Date.now() });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return out_({ ok: false, error: 'busy' });
  try {
    const sheet = sheet_();
    const current = loadAll_(sheet);
    const incoming = []
      .concat(Array.isArray(body.places) ? body.places : [], Array.isArray(body.tombs) ? body.tombs : [])
      .filter(valid).map(sanitize);
    const merged = mergeSets(current, incoming);
    sortForSheet_(merged);
    const before = JSON.stringify(current), after = JSON.stringify(merged);
    const changed = before !== after;
    if (changed) saveAll_(sheet, merged);
    const ver = changed ? bumpVer_() : getVer_();
    return out_({ ok: true, places: merged, changed, ver, time: Date.now() });
  } catch (err) {
    return out_({ ok: false, error: String((err && err.message) || err) });
  } finally {
    lock.releaseLock();
  }
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function sheet_() {
  const ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  return sh;
}
const HEADER = ['key', '이름', '주소', '분류', '점수', '평균', '메모', '방문일', '상태', '수정', 'json'];
const JSON_COL = HEADER.length;

function loadAll_(sheet) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, JSON_COL, last - 1, 1).getValues();
  const out = [];
  for (const row of values) {
    const s = row[0];
    if (!s) continue;
    try { const p = JSON.parse(s); if (valid(p)) out.push(sanitize(p)); } catch (err) { /* 깨진 줄은 건너뜀 */ }
  }
  sortForSheet_(out);
  return out;
}
function sortForSheet_(arr) {
  arr.sort((a, b) => (Number(!!a.deleted) - Number(!!b.deleted)) || a.name.localeCompare(b.name, 'ko') || String(a.id).localeCompare(String(b.id)));
}
function cell_(s) { // '=' 로 시작하는 글은 수식으로 읽히니 글자로 고정
  s = s == null ? '' : String(s);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
function saveAll_(sheet, records) {
  const rows = records.map((p) => {
    const names = Object.keys(p.ratings);
    const avg = names.length ? Math.round((names.reduce((s, n) => s + p.ratings[n], 0) / names.length) * 100) / 100 : '';
    return [
      keyOf(p), cell_(p.name), cell_(p.address), cell_(p.category),
      cell_(names.map((n) => n + ' ' + p.ratings[n]).join(' · ')), avg,
      cell_(p.memo), cell_(p.visitedAt), p.deleted ? '삭제' : '', new Date(p.updatedAt), JSON.stringify(p),
    ];
  });
  sheet.clearContents();
  sheet.getRange(1, 1, 1, HEADER.length).setValues([HEADER]).setFontWeight('bold');
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, HEADER.length).setValues(rows);
    sheet.getRange(2, 10, rows.length, 1).setNumberFormat('yyyy-mm-dd hh:mm');
  }
  sheet.setFrozenRows(1);
}
