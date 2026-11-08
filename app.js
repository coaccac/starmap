/* 내 별점 지도 — 실제 식당 데이터는 카카오맵에서 검색해 가져오고, 지도에는 우리가 별점 매긴 곳만 띄운다.
   이 폰을 쓰는 사람은 처음 켤 때 자기 이름을 넣고, 점수는 그 이름으로 저장된다.
   한 식당의 ratings 는 { 이름: 점수 } 꼴이고, 배지는 평균을 보여준다. */
(() => {
'use strict';

const STYLE_URLS = {
  positron: 'https://tiles.openfreemap.org/styles/positron',
  bright: 'https://tiles.openfreemap.org/styles/bright',
  liberty: 'https://tiles.openfreemap.org/styles/liberty',
};
const LS_PLACES = 'starmap.places.v1';
const LS_SETTINGS = 'starmap.settings.v1';
const LS_VIEW = 'starmap.view.v1';
const LS_TOMBS = 'starmap.tombs.v1';   // 지운 식당의 흔적 (다른 폰에도 삭제를 전하기 위해)
const LS_SYNC = 'starmap.sync.v1';     // 마지막 동기화 시각 등
const DEFAULT_CENTER = [126.9780, 37.5665]; // 서울시청
const DEFAULT_ZOOM = 12;

// 점수 → 색. 2점 이하는 지도에 묻히는 회색, 2.5부터 코랄이 점점 깊어진다.
const RATING_COLORS = {
  '10': '#D6DAE0', '15': '#C6CCD4', '20': '#B4BCC7',
  '25': '#F3B4A3', '30': '#F19379', '35': '#EE795B', '40': '#E85A3A', '45': '#D4421F', '50': '#B02D0E',
};
const NONE_COLOR = '#ECEEF1'; // 아직 안 매긴 쪽
const LOCK_COLOR = '#9AA5B1'; // 내 점수가 없어서 상대 점수를 가린 곳 (물음표 배지)
const RATING_TEXT_DARK = new Set(['10', '15', '20', '25']);
const KO_NAME = ['coalesce', ['get', 'name:ko'], ['get', 'name:nonlatin'], ['get', 'name:latin'], ['get', 'name']];
const RATING_NUM = ['number', ['get', 'rating'], 3];
const UI_FONT = '"NanumSquareNeo", -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", system-ui, sans-serif';
const DOT_ME = '#0EA5E9', DOT_OTHER = '#8B5CF6'; // 사람 구분용 점 색 (점수 색과 별개)

// config.js 에 적어 둔 기본 키. 설정 화면에서 다른 키를 넣으면 그게 우선.
const DEFAULT_KAKAO_KEY = (window.STARMAP_CONFIG && String(window.STARMAP_CONFIG.kakaoKey || '').trim()) || '';
// config.js 에 적어 둔 동기화 주소(Apps Script 웹 앱 URL). 설정 화면에서 넣은 주소가 우선.
const DEFAULT_SYNC_URL = (window.STARMAP_CONFIG && String(window.STARMAP_CONFIG.syncUrl || '').trim()) || '';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

// ---------- 저장 ----------
function loadJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
}
function saveJSON(key, v) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { toast('저장 공간이 부족해요'); }
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function today() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function clampRating(r) {
  r = Math.round(Number(r) * 2) / 2;
  if (!Number.isFinite(r)) return null;
  return Math.min(5, Math.max(1, r));
}
function ratingKey(r) { return String(Math.round(Math.min(5, Math.max(1, Math.round(Number(r) * 2) / 2)) * 10)); }
function ratingColor(r) { return r == null ? NONE_COLOR : RATING_COLORS[ratingKey(r)]; }
function isDarkText(avg) { return RATING_TEXT_DARK.has(ratingKey(avg)); }
function ratingLabel(r) {
  if (r < 2) return '다시는 안 가요';
  if (r < 3) return '그냥 그랬어요';
  if (r < 4) return '괜찮았어요';
  if (r < 4.5) return '맛있어요';
  if (r < 5) return '꼭 다시 갈 곳';
  return '최애';
}
function fmtRating(r) { return Number(r).toFixed(1); }
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function distText(m) {
  if (m == null || !Number.isFinite(m)) return '';
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
}
function haversine(a, b) {
  const R = 6371000, toR = (x) => (x * Math.PI) / 180;
  const dLat = toR(b.lat - a.lat), dLng = toR(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

let settings = Object.assign(
  {
    style: 'positron', kakaoKey: '', osmFallback: false, nearby: false, minRating: 0,
    showRoads: false, showGu: true, me: '',
    syncUrl: '', syncToken: '', autoSync: true,
  },
  loadJSON(LS_SETTINGS, {}),
);
if (!STYLE_URLS[settings.style]) settings.style = 'positron';
settings.me = String(settings.me || '').trim();
function me() { return settings.me || '나'; }

// ---------- 점수 (이름 → 점수) ----------
function normalizeRatings(p) {
  const out = {};
  const src = p.ratings && typeof p.ratings === 'object' ? p.ratings : null;
  if (src) {
    const legacyUsers = settings.users && typeof settings.users === 'object' ? settings.users : {};
    for (const [k, v] of Object.entries(src)) {
      const val = clampRating(v);
      if (val == null) continue;
      let name = String(k).trim();
      if (name === 'a') name = String(legacyUsers.a || '').trim() || me(); // 예전 형식
      else if (name === 'b') name = String(legacyUsers.b || '').trim() || '상대';
      if (name) out[name] = val;
    }
  } else if (p.rating != null) {
    const val = clampRating(p.rating);
    if (val != null) out[me()] = val;
  }
  return out;
}
function raterNames(r) { return Object.keys(r).filter((k) => r[k] != null); }
function avgOf(r) {
  const v = raterNames(r).map((k) => r[k]);
  if (!v.length) return null;
  return Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 100) / 100;
}
// 표시 순서: 나 먼저, 그다음 나머지 (이름순)
function orderedRaters(r, includeMe) {
  const names = raterNames(r).filter((k) => k !== me()).sort((a, b) => a.localeCompare(b, 'ko'));
  if (includeMe || r[me()] != null) names.unshift(me());
  return names;
}
// 배지 반원: 왼쪽 = 나, 오른쪽 = 첫 번째 다른 사람
function badgeHalves(r) {
  const others = orderedRaters(r, false).filter((k) => k !== me());
  return { left: r[me()] != null ? r[me()] : null, right: others.length ? r[others[0]] : null };
}
// 내가 아직 안 매긴 식당은 다른 사람 점수를 숨긴다. 내 점수를 저장해야 상대 점수와 평균이 보인다 (서로 영향 안 받게).
function isLocked(r) { return r[me()] == null && raterNames(r).length > 0; }
// 사람별로 점수를 마지막으로 바꾼 시각 { 이름: ms }. 동기화에서 사람마다 더 최근 점수를 고르는 기준.
function normalizeRatedAt(src) {
  const out = {};
  if (src && typeof src === 'object') {
    for (const [k, v] of Object.entries(src)) {
      const n = Number(v), name = String(k).trim();
      if (name && Number.isFinite(n) && n > 0) out[name] = n;
    }
  }
  return out;
}
function normalizePlace(p) {
  const ratings = normalizeRatings(p);
  const avg = avgOf(ratings);
  return {
    id: typeof p.id === 'string' && p.id ? p.id : uid(),
    kakaoId: p.kakaoId ? String(p.kakaoId) : '',
    name: String(p.name || '').trim(),
    lat: Number(p.lat), lng: Number(p.lng),
    ratings,
    ratedAt: normalizeRatedAt(p.ratedAt),
    rating: avg == null ? 3 : avg, // 평균 (필터·정렬·색에 사용)
    category: String(p.category || '').trim(),
    memo: String(p.memo || ''),
    address: String(p.address || ''),
    phone: String(p.phone || ''),
    placeUrl: String(p.placeUrl || ''),
    visitedAt: String(p.visitedAt || ''),
    createdAt: Number(p.createdAt) || Date.now(),
    updatedAt: Number(p.updatedAt) || Date.now(),
  };
}

let places = (loadJSON(LS_PLACES, []) || [])
  .filter((p) => p && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)))
  .map(normalizePlace);
// 지운 식당의 흔적. 동기화가 다른 폰에 삭제를 전할 때까지 들고 있다 (시트에도 '삭제' 줄로 남음).
let tombs = (loadJSON(LS_TOMBS, []) || [])
  .filter((p) => p && p.id)
  .map((p) => Object.assign(normalizePlace(p), { deleted: true }));
let syncState = Object.assign({ lastAt: 0, lastCount: 0, dirty: false, error: '' }, loadJSON(LS_SYNC, {}));
delete settings.users; // 예전 설정 정리

// 사용자가 데이터를 바꿨을 때. (동기화로 받아 온 데이터는 applySync 가 직접 저장한다)
function savePlaces() { saveJSON(LS_PLACES, places); saveJSON(LS_TOMBS, tombs); refreshData(); markDirty(); }
function saveSettings() { saveJSON(LS_SETTINGS, settings); }
function activeKakaoKey() { return settings.kakaoKey || DEFAULT_KAKAO_KEY; }
function searchProvider() {
  if (activeKakaoKey()) return 'kakao';
  if (settings.osmFallback) return 'osm';
  return null;
}
// 데이터에 등장하는 모든 사람 이름 (나 제외)
function knownOthers() {
  const s = new Set();
  for (const p of places) for (const k of raterNames(p.ratings)) if (k !== me()) s.add(k);
  return Array.from(s).sort((a, b) => a.localeCompare(b, 'ko'));
}

// ---------- 배지 그리기 ----------
// 지도 마커: 왼쪽 반원 = 나, 오른쪽 반원 = 상대, 가운데 = 평균. 평균이 높을수록 크다.
function badgeSize(avg) { return Math.round(22 + ((Math.min(5, Math.max(1, avg)) - 1) / 4) * 16); } // 22 ~ 38 css px
function badgeId(r) {
  if (isLocked(r)) return 'badge-lock';
  const h = badgeHalves(r), avg = avgOf(r);
  const k = (v) => (v == null ? 'x' : ratingKey(v));
  return `badge-${k(h.left)}-${k(h.right)}-${Math.round(avg * 100)}`;
}
function parseBadgeId(id) {
  if (id === 'badge-lock') return { lock: true };
  const m = /^badge-(x|\d\d)-(x|\d\d)-(\d+)$/.exec(id);
  if (!m) return null;
  const avg = Number(m[3]) / 100;
  if (!Number.isFinite(avg) || avg < 1 || avg > 5) return null;
  return { left: m[1] === 'x' ? null : Number(m[1]) / 10, right: m[2] === 'x' ? null : Number(m[2]) / 10, avg };
}
function halfPath(ctx, cx, cy, R, left) {
  ctx.beginPath();
  if (left) ctx.arc(cx, cy, R, Math.PI / 2, (3 * Math.PI) / 2);
  else ctx.arc(cx, cy, R, -Math.PI / 2, Math.PI / 2);
  ctx.closePath();
}
function makeBadgeImage(b) {
  const lock = !!b.lock; // 내 점수가 없는 곳: 회색 물음표
  const avg = lock ? null : b.avg;
  const pr = 2;
  const size = lock ? 26 : badgeSize(avg);
  const pad = 8;
  const s = (size + pad * 2) * pr;
  const c = document.createElement('canvas');
  c.width = s; c.height = s;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const cx = s / 2, cy = s / 2, R = (size / 2) * pr;

  if (!lock && avg >= 4.75) { // 최애급이면 바깥 링
    ctx.beginPath(); ctx.arc(cx, cy, R + 4 * pr, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(176,45,14,0.18)'; ctx.fill();
  }
  ctx.save();
  ctx.shadowColor = 'rgba(16,24,40,0.28)'; ctx.shadowBlur = 5 * pr; ctx.shadowOffsetY = 1.5 * pr;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = '#FFFFFF'; ctx.fill();
  ctx.restore();

  const Ri = R - 2 * pr;
  if (lock) {
    ctx.beginPath(); ctx.arc(cx, cy, Ri, 0, Math.PI * 2); ctx.fillStyle = LOCK_COLOR; ctx.fill();
  } else {
    halfPath(ctx, cx, cy, Ri, true); ctx.fillStyle = ratingColor(b.left); ctx.fill();
    halfPath(ctx, cx, cy, Ri, false); ctx.fillStyle = ratingColor(b.right); ctx.fill();
    ctx.beginPath(); ctx.moveTo(cx, cy - Ri); ctx.lineTo(cx, cy + Ri);
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.3 * pr; ctx.stroke();
  }

  const label = lock ? '?' : fmtRating(avg);
  const dark = lock ? false : isDarkText(avg);
  ctx.font = `800 ${Math.round(size * (lock ? 0.5 : 0.38)) * pr}px ${UI_FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2.2 * pr;
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.85)' : 'rgba(60,20,10,0.35)';
  if (!lock) ctx.strokeText(label, cx, cy + 0.5 * pr);
  ctx.fillStyle = dark ? '#2B3440' : '#FFFFFF';
  ctx.fillText(label, cx, cy + 0.5 * pr);
  return { data: ctx.getImageData(0, 0, s, s), pixelRatio: pr };
}
// 화면(목록/상세/검색)용 배지. ratings 객체를 받는다.
function badgeHTML(r, px) {
  const avg = avgOf(r);
  const size = px || 34;
  if (isLocked(r)) return lockBadge(size);
  if (avg == null) return `<span class="badge none" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.34)}px">–</span>`;
  const h = badgeHalves(r);
  const dark = isDarkText(avg);
  const bg = `linear-gradient(90deg, ${ratingColor(h.left)} 0 50%, ${ratingColor(h.right)} 50% 100%)`;
  const shadow = dark ? '0 0 2px rgba(255,255,255,.9)' : '0 0 2px rgba(60,20,10,.5)';
  return `<span class="badge" style="width:${size}px;height:${size}px;background:${bg};color:${dark ? '#2B3440' : '#fff'};font-size:${Math.round(size * 0.38)}px;text-shadow:${shadow}">${fmtRating(avg)}</span>`;
}
function lockBadge(px) {
  const size = px || 24;
  return `<span class="badge lock" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.46)}px" title="내 점수를 매기면 공개">?</span>`;
}
function miniBadge(v, px) {
  const size = px || 24;
  if (v == null) return `<span class="badge none" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.4)}px">–</span>`;
  const dark = RATING_TEXT_DARK.has(ratingKey(v));
  return `<span class="badge" style="width:${size}px;height:${size}px;background:${ratingColor(v)};color:${dark ? '#2B3440' : '#fff'};font-size:${Math.round(size * 0.4)}px">${fmtRating(v)}</span>`;
}
// 별점 선택용 별 (둥근 모서리)
const STAR_POINTS = (() => {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? 19 : 9.5;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push((24 + Math.cos(a) * rad).toFixed(2) + ',' + (24 + Math.sin(a) * rad).toFixed(2));
  }
  return pts.join(' ');
})();
let svgSeq = 0;
function starSVG(fill, opts = {}) {
  let defs = '', fillAttr = fill, strokeAttr = fill;
  if (opts.half) {
    const id = 'half' + (svgSeq++);
    defs = `<defs><linearGradient id="${id}"><stop offset="50%" stop-color="${fill}"/><stop offset="50%" stop-color="#E5E7EB"/></linearGradient></defs>`;
    fillAttr = `url(#${id})`; strokeAttr = `url(#${id})`;
  }
  if (opts.empty) { fillAttr = '#E5E7EB'; strokeAttr = '#E5E7EB'; }
  return `<svg viewBox="0 0 48 48" aria-hidden="true">${defs}<polygon points="${STAR_POINTS}" fill="${fillAttr}" stroke="${strokeAttr}" stroke-width="5" stroke-linejoin="round"/></svg>`;
}
function starsHTML(v) {
  const col = ratingColor(Math.max(v || 3, 3)); // 선택 UI의 별은 항상 코랄 계열
  let html = '';
  for (let i = 1; i <= 5; i++) {
    const svg = v != null && v >= i ? starSVG(col) : (v != null && v >= i - 0.5 ? starSVG(col, { half: true }) : starSVG('#E5E7EB', { empty: true }));
    html += `<button type="button" data-i="${i}" aria-label="${i}점">${svg}</button>`;
  }
  return html;
}

// ---------- 지도 ----------
const savedView = loadJSON(LS_VIEW, null);
// 지도 위 한글 라벨(식당 이름·구 이름·동네 이름)은 MapLibre가 기기 글꼴로 직접 그린다 (localIdeographFontFamily 는
// 한글 음절 범위에 적용). 글꼴이 오기 전에 그리면 시스템 글꼴로 굳으니, 빈 스타일로 띄운 뒤 글꼴이 준비되면 진짜 스타일을 얹는다.
const EMPTY_STYLE = { version: 8, sources: {}, layers: [] };
const map = new maplibregl.Map({
  container: 'map',
  style: EMPTY_STYLE,
  center: savedView && Array.isArray(savedView.center) ? savedView.center : DEFAULT_CENTER,
  zoom: savedView && Number.isFinite(savedView.zoom) ? savedView.zoom : DEFAULT_ZOOM,
  attributionControl: false,
  maxZoom: 19,
  localIdeographFontFamily: '"NanumSquareNeo", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
});
const fontReady = (document.fonts && document.fonts.load)
  ? Promise.race([
    Promise.all([document.fonts.load('400 24px NanumSquareNeo'), document.fonts.load('800 24px NanumSquareNeo')]),
    new Promise((r) => setTimeout(r, 2000)), // 글꼴이 너무 늦으면 그냥 시작
  ]).catch(() => {})
  : Promise.resolve();
fontReady.then(() => map.setStyle(STYLE_URLS[settings.style]));
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
map.touchPitch.disable();
map.on('moveend', () => saveJSON(LS_VIEW, { center: map.getCenter().toArray(), zoom: map.getZoom() }));
map.on('style.load', onStyleLoad);
map.on('error', (e) => console.warn('map error', e && e.error));
// 배지 이미지는 조합이 많아서 필요할 때 만들어 넣는다.
const badgeImageIds = new Set();
map.on('styleimagemissing', (e) => {
  const b = parseBadgeId(e.id);
  if (!b || map.hasImage(e.id)) return;
  const img = makeBadgeImage(b);
  map.addImage(e.id, img.data, { pixelRatio: img.pixelRatio });
  badgeImageIds.add(e.id);
});
// 웹 글꼴이 늦게 도착하면 먼저 그린 배지는 시스템 글꼴이다. 글꼴이 준비되면 지우고 다시 그리게 한다.
if (document.fonts && document.fonts.load) {
  document.fonts.load('800 20px NanumSquareNeo').then(() => {
    if (!badgeImageIds.size) return;
    for (const id of badgeImageIds) if (map.hasImage(id)) map.removeImage(id);
    badgeImageIds.clear();
    refreshData();
  }).catch(() => {});
}

let fontStack = ['Noto Sans Regular'];
let guFont = ['Noto Sans Bold'];
let roadLabelLayers = []; // 도로명·도로번호 레이어 (기본 숨김, 설정에서 켤 수 있음)

// 서울 구 경계 (data/seoul-gu.json, WGS84). 라벨은 미리 계산해 둔 중심점(cx, cy)에 찍는다.
const EMPTY_FC = { type: 'FeatureCollection', features: [] };
let guData = null, guLabelData = null;
fetch('data/seoul-gu.json').then((r) => r.json()).then((fc) => {
  guData = fc;
  guLabelData = {
    type: 'FeatureCollection',
    features: fc.features.map((f) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [f.properties.cx, f.properties.cy] },
      properties: { name: f.properties.name },
    })),
  };
  const s1 = map.getSource('seoul-gu'); if (s1) s1.setData(guData);
  const s2 = map.getSource('seoul-gu-labels'); if (s2) s2.setData(guLabelData);
  regionCache.clear();
  if (!$('#sheetList').classList.contains('hidden')) renderList();
}).catch((e) => console.warn('gu data', e));

function vis(on) { return on ? 'visible' : 'none'; }
function applyLayerToggles() {
  for (const id of roadLabelLayers) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis(settings.showRoads));
  for (const id of ['gu-line', 'gu-label']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis(settings.showGu !== false));
}

function onStyleLoad() {
  const style = map.getStyle();
  if (!style || !style.layers || !style.glyphs) return; // 글꼴 기다리는 동안의 빈 스타일은 건너뜀
  roadLabelLayers = [];
  // 1) 가게/건물 라벨(POI)은 전부 숨기고, 2) 도로명·도로번호는 설정에 따라, 3) 지명은 한국어로
  for (const l of style.layers) {
    const sl = l['source-layer'] || '';
    if (sl === 'poi' || sl === 'housenumber' || /(^|[_-])poi([_-]|$)/i.test(l.id)) {
      map.setLayoutProperty(l.id, 'visibility', 'none');
      continue;
    }
    if (sl === 'transportation_name' || sl === 'aerodrome_label') {
      roadLabelLayers.push(l.id);
      map.setLayoutProperty(l.id, 'visibility', vis(settings.showRoads));
    }
    if (l.type === 'symbol' && l.layout && l.layout['text-field']) {
      const tf = JSON.stringify(l.layout['text-field']);
      if (tf.indexOf('name') !== -1) map.setLayoutProperty(l.id, 'text-field', KO_NAME);
      // 물 이름 같은 이탤릭 묶음은 한글을 기기 글꼴로 그릴 때 억지로 기울어져 보기 싫다 → 정자체로
      const tfont = l.layout['text-font'];
      if (Array.isArray(tfont) && tfont.every((f) => typeof f === 'string') && tfont.some((f) => /italic/i.test(f))) {
        map.setLayoutProperty(l.id, 'text-font', tfont.map((f) => f.replace(/\s*Italic/i, ' Regular').replace(/\s+/g, ' ').trim()));
      }
    }
  }
  // 우리 라벨에 쓸 글꼴 묶음: 스타일에 있는 것 중 이탤릭이 아닌 Regular / Bold
  const stacks = style.layers
    .filter((l) => l.type === 'symbol' && l.layout && Array.isArray(l.layout['text-font']) && l.layout['text-font'].every((f) => typeof f === 'string'))
    .map((l) => l.layout['text-font'])
    .filter((s) => !s.some((f) => /italic/i.test(f)));
  const pick = (re) => stacks.find((s) => s.some((f) => re.test(f)));
  fontStack = pick(/regular/i) || stacks[0] || ['Noto Sans Regular'];
  guFont = pick(/bold/i) || fontStack;

  // 4) 서울 구 경계선 + 구 이름 (내 마커 아래에 깔림)
  if (!map.getSource('seoul-gu')) map.addSource('seoul-gu', { type: 'geojson', data: guData || EMPTY_FC });
  if (!map.getSource('seoul-gu-labels')) map.addSource('seoul-gu-labels', { type: 'geojson', data: guLabelData || EMPTY_FC });
  if (!map.getLayer('gu-line')) {
    map.addLayer({
      id: 'gu-line', type: 'line', source: 'seoul-gu',
      layout: { 'line-join': 'round', 'line-cap': 'round', visibility: vis(settings.showGu !== false) },
      paint: {
        'line-color': '#7B8794',
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.8, 12, 1.4, 15, 2],
        'line-opacity': 0.8,
      },
    });
  }
  if (!map.getLayer('gu-label')) {
    map.addLayer({
      id: 'gu-label', type: 'symbol', source: 'seoul-gu-labels',
      layout: {
        'text-field': ['get', 'name'],
        'text-font': guFont,
        'text-size': ['interpolate', ['linear'], ['zoom'], 9, 11, 11, 13, 13, 15],
        'text-letter-spacing': 0.08,
        'text-padding': 6,
        visibility: vis(settings.showGu !== false),
      },
      paint: {
        'text-color': '#52606D',
        'text-halo-color': 'rgba(255,255,255,0.92)',
        'text-halo-width': 1.6,
        'text-opacity': ['interpolate', ['linear'], ['zoom'], 13.5, 0.9, 15.5, 0.3],
      },
    });
  }

  // 5) 점수 배지 + 우리 식당 레이어
  if (!map.getSource('places')) map.addSource('places', { type: 'geojson', data: toGeoJSON() });
  if (!map.getLayer('places')) {
    map.addLayer({
      id: 'places', type: 'symbol', source: 'places',
      layout: {
        'icon-image': ['get', 'bid'],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'symbol-sort-key': RATING_NUM,
        'text-field': ['get', 'name'],
        'text-font': fontStack,
        'text-size': 11,
        // 배지 아래가 기본, 자리가 없으면 위·왼쪽·오른쪽으로 옮겨 가며 이름을 되도록 보여 준다
        'text-variable-anchor': ['top', 'bottom', 'left', 'right'],
        // 배지 반지름(11~19px) + 여백만큼 떨어뜨림 (em 단위)
        'text-radial-offset': ['interpolate', ['linear'], RATING_NUM, 1, 1.3, 5, 2.0],
        'text-justify': 'auto',
        'text-optional': true,
        'text-max-width': 12,
        'text-letter-spacing': 0.01,
      },
      paint: {
        'text-color': '#1F2933',
        'text-halo-color': 'rgba(255,255,255,0.96)',
        'text-halo-width': 1.8,
      },
    });
  }
}

// ★4+ 같은 필터: 평균이 그 점수 이상인 곳만. 내 점수가 없어 가려진 곳(물음표)은 거르지 않고 그대로 둔다.
// 물음표 버튼(onlyLocked)이 켜져 있으면 안 매긴 곳만.
let onlyLocked = false;
function shownByFilter(p) {
  if (onlyLocked) return isLocked(p.ratings);
  const min = Number(settings.minRating) || 0;
  return isLocked(p.ratings) || p.rating >= min;
}
function toGeoJSON() {
  return {
    type: 'FeatureCollection',
    features: places.filter(shownByFilter).map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
      properties: { id: p.id, name: p.name, rating: isLocked(p.ratings) ? 3 : p.rating, bid: badgeId(p.ratings) },
    })),
  };
}
function refreshData() {
  const src = map.getSource('places');
  if (src) src.setData(toGeoJSON());
  const min = Number(settings.minRating) || 0;
  const shown = places.filter(shownByFilter).length;
  $('#pill').textContent = onlyLocked ? `안 매긴 곳 ${shown}` : (min > 0 ? `${shown} / ${places.length}곳` : `${places.length}곳`);
  renderFilterChips();
  if (!$('#sheetList').classList.contains('hidden')) renderList();
  $('#dataHint').textContent = activeSyncUrl()
    ? `저장된 곳 ${places.length}개 · 구글 시트와 맞추고 있어요. 그래도 가끔 내보내기로 백업해 두세요.`
    : `저장된 곳 ${places.length}개 · 데이터는 이 기기(브라우저) 안에만 저장돼요. 가끔 내보내기로 백업해 두세요.`;
  const others = knownOthers();
  $('#sOthers').textContent = others.length ? `같이 매긴 사람: ${others.join(', ')}` : '아직 다른 사람 점수는 없어요.';
}

// 점수 필터 (지도 위 칩과 목록 머리의 칩이 같은 값을 공유)
function renderFilterChips() {
  const min = Number(settings.minRating) || 0;
  $$('#mapFilter .chip, #chips .chip').forEach((c) => c.classList.toggle('on', !onlyLocked && Number(c.dataset.min) === min));
  $('#mapFilter').classList.toggle('dim', onlyLocked);
  $('#chips').classList.toggle('dim', onlyLocked);
  $('#btnTodo').classList.toggle('on', onlyLocked);
}
function setMinRating(v) {
  onlyLocked = false; // 점수 칩을 누르면 물음표 모드는 끔
  settings.minRating = Number(v) || 0;
  saveSettings();
  refreshData();
  if (!$('#sheetList').classList.contains('hidden')) renderList();
}
$('#mapFilter').addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (c) setMinRating(c.dataset.min); // 안내 문구 없이 조용히 (알약의 개수로 충분)
});
// 물음표 버튼: 내가 아직 안 매긴 곳만 보기 (켜져 있는 동안은 점수 칩을 무시)
$('#btnTodo').addEventListener('click', () => {
  if (!onlyLocked && !places.some((p) => isLocked(p.ratings))) { toast('내가 아직 안 매긴 곳이 없어요'); return; }
  onlyLocked = !onlyLocked;
  refreshData();
  if (!$('#sheetList').classList.contains('hidden')) renderList();
});

map.on('click', 'places', (e) => {
  const f = e.features && e.features[0];
  if (f) openDetail(f.properties.id);
});
map.on('mouseenter', 'places', () => { map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'places', () => { map.getCanvas().style.cursor = ''; });

// ---------- 구 판정 (point in polygon) ----------
const regionCache = new Map();
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    const hit = ((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}
function pointInFeature(pt, f) {
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  return polys.some((poly) => pointInRing(pt, poly[0]) && !poly.slice(1).some((h) => pointInRing(pt, h)));
}
// 묶음 기준: 1) 카카오 주소의 구 ("서울 중구 ..."), 2) 서울 밖이면 주소 앞 두 토큰 ("경기 성남시"),
// 3) 주소가 없으면(직접 찍은 곳) 구 경계 폴리곤으로 판정, 4) 그래도 없으면 "기타".
function regionOf(p) {
  const key = p.id + ':' + p.lat.toFixed(5) + ',' + p.lng.toFixed(5) + ':' + (p.address || '');
  if (regionCache.has(key)) return regionCache.get(key);
  let r = null;
  if (p.address) {
    const t = p.address.trim().split(/\s+/);
    if (t[0] && /^서울/.test(t[0]) && t[1] && /구$/.test(t[1])) r = t[1];
    else if (t[0] && t[1] && !/^서울/.test(t[0])) r = t.slice(0, 2).join(' ');
  }
  if (!r && guData) {
    const f = guData.features.find((x) => pointInFeature([p.lng, p.lat], x));
    if (f) r = f.properties.name;
  }
  if (!r && p.address) r = p.address.trim().split(/\s+/).slice(0, 2).join(' ');
  if (!r) r = '기타';
  if (guData) regionCache.set(key, r);
  return r;
}
function guBounds(name) {
  if (!guData) return null;
  const f = guData.features.find((x) => x.properties.name === name);
  if (!f) return null;
  const b = new maplibregl.LngLatBounds();
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
  for (const poly of polys) for (const c of poly[0]) b.extend(c);
  return b;
}

// ---------- 내 위치 ----------
let meMarker = null;
let myPos = null; // { lat, lng, t }
function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('unsupported'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
      reject,
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 20000 },
    );
  });
}
async function getMyPos(maxAgeMs = 120000) {
  if (myPos && Date.now() - myPos.t < maxAgeMs) return myPos;
  const pos = await locate();
  myPos = { lat: pos.lat, lng: pos.lng, t: Date.now() };
  showMe(myPos);
  return myPos;
}
function showMe(pos) {
  if (!meMarker) {
    const el = document.createElement('div');
    el.className = 'me-dot';
    meMarker = new maplibregl.Marker({ element: el }).setLngLat([pos.lng, pos.lat]).addTo(map);
  } else {
    meMarker.setLngLat([pos.lng, pos.lat]);
  }
}
function geoErrorText(e) {
  if (e && e.code === 1) return '위치 권한이 꺼져 있어요. 설정에서 Safari 위치 접근을 허용해 주세요.';
  const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!secure) return '위치 기능은 https 주소에서만 동작해요.';
  return '위치를 가져오지 못했어요.';
}
$('#btnLocate').addEventListener('click', async () => {
  const b = $('#btnLocate');
  b.classList.add('busy');
  try {
    const pos = await getMyPos(10000);
    map.flyTo({ center: [pos.lng, pos.lat], zoom: Math.max(map.getZoom(), 16), speed: 1.4 });
  } catch (e) {
    toast(geoErrorText(e));
  } finally {
    b.classList.remove('busy');
  }
});

// ---------- 시트 / 페이지 ----------
const SHEETS = ['sheetAdd', 'sheetDetail', 'sheetList', 'sheetSettings', 'sheetSetup', 'sheetNames', 'sheetSyncHelp'];
function openSheet(id) {
  for (const s of SHEETS) { const el = $('#' + s); el.classList.toggle('hidden', s !== id); el.style.transform = ''; }
  $('#backdrop').classList.remove('hidden');
}
// 시트 닫기: ✕ 버튼, 또는 손잡이·제목 부분(목록은 맨 위에서)을 아래로 쓸어내리기
document.addEventListener('click', (e) => { if (e.target.closest('.sheet-close')) closeSheets(); });
let swipe = null;
document.addEventListener('touchstart', (e) => {
  const sheet = e.target.closest('.sheet');
  if (!sheet || (sheet.id === 'sheetNames' && !settings.me) || e.target.closest('input, textarea, select')) { swipe = null; return; }
  const head = !!e.target.closest('.grip, h2, .list-head, .detail-head');
  if (!head && sheet.scrollTop > 0) { swipe = null; return; }
  swipe = { y0: e.touches[0].clientY, sheet, head, dy: 0 };
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (!swipe) return;
  swipe.dy = e.touches[0].clientY - swipe.y0;
  if (swipe.dy > 0 && (swipe.head || swipe.sheet.scrollTop <= 0)) swipe.sheet.style.transform = `translateY(${swipe.dy}px)`;
  else swipe.sheet.style.transform = '';
}, { passive: true });
document.addEventListener('touchend', () => {
  if (!swipe) return;
  const s = swipe; swipe = null;
  s.sheet.style.transform = '';
  if (s.dy > 90) closeSheets();
});
document.addEventListener('touchcancel', () => { if (swipe) { swipe.sheet.style.transform = ''; swipe = null; } });
function closeSheets() {
  for (const s of SHEETS) $('#' + s).classList.add('hidden');
  $('#backdrop').classList.add('hidden');
  clearDraft();
}
function closeAll() {
  closeSheets();
  $('#pageSearch').classList.add('hidden');
}
$('#backdrop').addEventListener('click', () => { if (!settings.me) return; closeSheets(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && settings.me) closeAll(); });

// ---------- 카카오 로컬 (실제 식당 데이터) ----------
let kakaoPromise = null;
function loadKakao() {
  if (kakaoPromise) return kakaoPromise;
  const key = activeKakaoKey();
  kakaoPromise = new Promise((resolve, reject) => {
    if (window.kakao && window.kakao.maps && window.kakao.maps.services) return resolve(window.kakao);
    const s = document.createElement('script');
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(key)}&libraries=services&autoload=false`;
    s.onload = () => {
      try { window.kakao.maps.load(() => resolve(window.kakao)); } catch (e) { reject(new Error('sdk-init')); }
    };
    s.onerror = () => reject(new Error('sdk-load'));
    document.head.appendChild(s);
  });
  kakaoPromise.catch(() => { kakaoPromise = null; });
  return kakaoPromise;
}
function fromKakaoDoc(d) {
  const cat = String(d.category_name || '');
  return {
    kakaoId: String(d.id || ''),
    name: d.place_name || '',
    category: cat.split('>').pop().trim(),
    categoryFull: cat,
    address: d.road_address_name || d.address_name || '',
    phone: d.phone || '',
    placeUrl: d.place_url || '',
    lat: Number(d.y), lng: Number(d.x),
    distance: d.distance !== undefined && d.distance !== '' ? Number(d.distance) : null,
  };
}
// onPage(items, pagination) 는 첫 페이지와 pagination.nextPage() 호출마다 불린다.
async function kakaoKeyword(q, opts, onPage, onError) {
  try {
    const k = await loadKakao();
    const ps = new k.maps.services.Places();
    const o = { size: 15 };
    if (opts.center) o.location = new k.maps.LatLng(opts.center.lat, opts.center.lng);
    if (opts.radius) o.radius = opts.radius;
    if (opts.byDistance) o.sort = k.maps.services.SortBy.DISTANCE;
    ps.keywordSearch(q, (data, status, pagination) => {
      if (status === k.maps.services.Status.OK) onPage(data.map(fromKakaoDoc), pagination);
      else if (status === k.maps.services.Status.ZERO_RESULT) onPage([], null);
      else onError(new Error('kakao ' + status));
    }, o);
  } catch (e) { onError(e); }
}
async function kakaoCategory(code, center, radius, onPage, onError) {
  try {
    const k = await loadKakao();
    const ps = new k.maps.services.Places();
    ps.categorySearch(code, (data, status, pagination) => {
      if (status === k.maps.services.Status.OK) onPage(data.map(fromKakaoDoc), pagination);
      else if (status === k.maps.services.Status.ZERO_RESULT) onPage([], null);
      else onError(new Error('kakao ' + status));
    }, { location: new k.maps.LatLng(center.lat, center.lng), radius, sort: k.maps.services.SortBy.DISTANCE, size: 15 });
  } catch (e) { onError(e); }
}
async function osmSearch(q, center) {
  const b = map.getBounds();
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&accept-language=ko&limit=15'
    + `&q=${encodeURIComponent(q)}&viewbox=${b.getWest()},${b.getNorth()},${b.getEast()},${b.getSouth()}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('osm ' + r.status);
  const arr = await r.json();
  return arr.map((x) => {
    const lat = Number(x.lat), lng = Number(x.lon);
    return {
      kakaoId: '', name: x.name || String(x.display_name).split(',')[0], category: '', categoryFull: '',
      address: x.display_name, phone: '', placeUrl: '', lat, lng,
      distance: center ? haversine(center, { lat, lng }) : null,
    };
  });
}

// ---------- 검색 페이지 ----------
let searchSeq = 0, searchItems = [], searchPagination = null, searchTimer = null;
function openSearch() {
  if (!settings.me) { openNames(); return; }
  if (!searchProvider()) { openSetup(); return; }
  closeSheets();
  $('#pageSearch').classList.remove('hidden');
  renderNearbyChip();
  setTimeout(() => $('#searchInput').focus(), 80);
  runSearch();
}
function closeSearch() { $('#pageSearch').classList.add('hidden'); }
function renderNearbyChip() {
  $('#chipNearby').classList.toggle('on', !!settings.nearby);
  $('#searchHint').textContent = settings.nearby
    ? '내 위치에서 가까운 순'
    : (searchProvider() === 'kakao' ? '카카오맵 검색 · 지도 중심 기준' : 'OpenStreetMap 검색');
}
function renderResults(state, items) {
  const box = $('#searchResults');
  $('#searchMore').classList.toggle('hidden', !(state === 'ok' && searchPagination));
  if (state === 'hint') {
    box.innerHTML = '<li class="r-empty">식당 이름이나 지역을 입력해요.<br>📍 내 주변을 켜면 지금 근처 식당이 바로 떠요.</li>';
    return;
  }
  if (state === 'loading') { box.innerHTML = '<li class="r-empty">검색 중…</li>'; return; }
  if (state === 'error') {
    box.innerHTML = searchProvider() === 'kakao'
      ? '<li class="r-empty">검색에 실패했어요.<br>설정에서 카카오 키와 도메인 등록을 확인해 주세요.</li>'
      : '<li class="r-empty">검색에 실패했어요.</li>';
    return;
  }
  if (!items.length) { box.innerHTML = '<li class="r-empty">결과가 없어요</li>'; return; }
  box.innerHTML = items.map((it, i) => {
    const reg = findRegistered(it);
    const sub = [it.category, distText(it.distance), it.address].filter(Boolean).join(' · ');
    let right;
    if (!reg) right = '<div class="r-right"><span class="r-add">등록</span></div>';
    else if (reg.ratings[me()] == null) right = `<div class="r-right">${badgeHTML(reg.ratings, 30)}<span class="r-add">내 점수</span></div>`;
    else right = `<div class="r-right">${badgeHTML(reg.ratings, 30)}</div>`;
    return `<li data-i="${i}"><div class="r-body"><div class="r-name">${esc(it.name)}</div><div class="r-sub">${esc(sub)}</div></div>${right}</li>`;
  }).join('');
}
function findRegistered(it) {
  if (it.kakaoId) {
    const byId = places.find((p) => p.kakaoId === it.kakaoId);
    if (byId) return byId;
  }
  return places.find((p) => p.name === it.name && haversine(p, it) < 60) || null;
}
async function runSearch(append = false) {
  const q = $('#searchInput').value.trim();
  const seq = ++searchSeq;
  if (!append) { searchItems = []; searchPagination = null; }
  const provider = searchProvider();
  if (!provider) return;
  if (!q && !settings.nearby) { renderResults('hint', []); return; }
  if (q.length === 1) return;

  let center = null;
  if (settings.nearby) {
    try { center = await getMyPos(); }
    catch (e) {
      toast(geoErrorText(e));
      settings.nearby = false; saveSettings(); renderNearbyChip();
      if (!q) { renderResults('hint', []); return; }
    }
  }
  if (seq !== searchSeq) return;
  renderResults('loading', []);

  const onPage = (items, pg) => {
    if (seq !== searchSeq) return;
    searchItems = searchItems.concat(items);
    searchPagination = pg && pg.hasNextPage ? pg : null;
    renderResults('ok', searchItems);
  };
  const onError = (e) => {
    if (seq !== searchSeq) return;
    console.warn(e);
    renderResults('error', []);
  };

  if (provider === 'kakao') {
    if (center) {
      if (q) kakaoKeyword(q, { center, radius: 3000, byDistance: true }, onPage, onError);
      else kakaoCategory('FD6', center, 800, onPage, onError); // 음식점
    } else {
      const c = map.getCenter();
      kakaoKeyword(q, { center: { lat: c.lat, lng: c.lng } }, onPage, onError);
    }
  } else {
    if (!q) { renderResults('hint', []); return; }
    osmSearch(q, center).then((items) => onPage(items, null)).catch(onError);
  }
}
$('#btnSearchOpen').addEventListener('click', openSearch);
$('#btnAdd').addEventListener('click', openSearch);
$('#btnSearchBack').addEventListener('click', closeSearch);
$('#searchInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => runSearch(), 400); });
$('#searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(); $('#searchInput').blur(); }
});
$('#searchClear').addEventListener('click', () => { $('#searchInput').value = ''; runSearch(); $('#searchInput').focus(); });
$('#chipNearby').addEventListener('click', async () => {
  settings.nearby = !settings.nearby;
  saveSettings();
  renderNearbyChip();
  runSearch();
});
$('#btnMore').addEventListener('click', () => {
  if (!searchPagination) return;
  const pg = searchPagination;
  searchPagination = null;
  $('#searchMore').classList.add('hidden');
  pg.nextPage(); // 같은 콜백(onPage)이 다시 불려 이어 붙는다
});
$('#searchResults').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  const it = searchItems[Number(li.dataset.i)];
  if (!it) return;
  const reg = findRegistered(it);
  closeAll();
  if (reg) {
    map.flyTo({ center: [reg.lng, reg.lat], zoom: Math.max(map.getZoom(), 16), offset: [0, -100] });
    if (reg.ratings[me()] == null) startDraft(Object.assign({}, reg, { source: 'edit' })); // 내 점수만 보태기
    else openDetail(reg.id);
    return;
  }
  startDraft(Object.assign({}, it, { source: it.kakaoId ? 'kakao' : 'search' }));
});
$('#btnManual').addEventListener('click', () => {
  closeAll();
  const c = map.getCenter();
  startDraft({ lat: c.lat, lng: c.lng, source: 'center' });
  toast('핀을 끌어서 위치를 맞춰 주세요');
});

// ---------- 카카오 키 설정 ----------
function openSetup() {
  closeAll();
  $('#setupOrigin').textContent = location.origin;
  $('#setupKey').value = settings.kakaoKey || '';
  openSheet('sheetSetup');
}
function applyKakaoKey(v) {
  settings.kakaoKey = (v || '').trim();
  kakaoPromise = null;
  saveSettings();
}
$('#btnSetupSave').addEventListener('click', () => {
  const v = $('#setupKey').value.trim();
  if (!v) { toast('키를 붙여넣어 주세요'); return; }
  applyKakaoKey(v);
  closeSheets();
  openSearch();
});
$('#btnSetupLater').addEventListener('click', closeSheets);
$('#btnUseOsm').addEventListener('click', () => {
  settings.osmFallback = true;
  saveSettings();
  closeSheets();
  openSearch();
});

// ---------- 처음 켤 때: 내 이름 ----------
function openNames() {
  closeAll();
  $('#nMe').value = settings.me || '';
  openSheet('sheetNames');
  setTimeout(() => $('#nMe').focus(), 300);
}
function renameUser(oldName, newName) {
  if (!oldName || oldName === newName) return;
  const now = Date.now();
  for (const p of places) {
    if (p.ratings[oldName] != null) {
      if (p.ratings[newName] == null) p.ratings[newName] = p.ratings[oldName];
      delete p.ratings[oldName];
      p.ratedAt[oldName] = now; p.ratedAt[newName] = now; // 다른 폰에도 이름 변경이 전해지도록
    }
  }
  saveJSON(LS_PLACES, places);
}
$('#btnNamesSave').addEventListener('click', () => {
  const v = $('#nMe').value.trim();
  if (!v) { toast('이름을 적어 주세요'); $('#nMe').focus(); return; }
  const prev = settings.me;
  settings.me = v;
  saveSettings();
  renameUser(prev || '나', v); // 이름 없이 저장됐던 점수("나")도 내 이름으로
  places = places.map(normalizePlace); // 예전 형식 점수를 내 이름으로
  savePlaces();
  closeSheets();
  toast(`${v}, 반가워요`);
  if (!places.length && !syncReady()) setTimeout(() => toast('위의 검색창에서 식당을 찾아 첫 별점을 등록해요'), 1800);
});
$('#nMe').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnNamesSave').click(); });

// ---------- 별점 등록 / 수정 ----------
let draft = null, draftMarker = null;
function startDraft(init) {
  closeSheets();
  const ratings = {};
  if (init.ratings) for (const [k, v] of Object.entries(init.ratings)) { const c = clampRating(v); if (c != null) ratings[k] = c; }
  draft = {
    id: init.id || null,
    ratedAt: Object.assign({}, init.ratedAt || {}),
    origRatings: Object.assign({}, ratings), // 저장할 때 누구 점수가 바뀌었는지 비교용
    orig: init.id ? {
      name: init.name || '', category: init.category || '', memo: init.memo || '', visitedAt: init.visitedAt || '',
      lat: init.lat, lng: init.lng, updatedAt: init.updatedAt,
    } : null,
    kakaoId: init.kakaoId || '',
    name: init.name || '',
    lat: init.lat, lng: init.lng,
    ratings,
    locked: isLocked(ratings), // 내 점수가 없고 남의 점수만 있으면, 저장할 때까지 남의 점수는 가림
    extra: [],          // 이 폰에서 추가로 매기는 다른 사람 (아직 점수 없음)
    addingOther: false,
    category: init.category || '',
    memo: init.memo || '',
    address: init.address || '',
    phone: init.phone || '',
    placeUrl: init.placeUrl || '',
    visitedAt: init.visitedAt != null ? init.visitedAt : today(),
    createdAt: init.createdAt,
    source: init.source || 'center',
  };
  const fromKakao = !!draft.kakaoId;
  $('#addTitle').textContent = draft.id ? '별점 수정' : '별점 등록';
  $('#placeCard').classList.toggle('hidden', !fromKakao);
  $('#manualFields').classList.toggle('hidden', fromKakao);
  if (fromKakao) {
    $('#pcName').textContent = draft.name;
    $('#pcSub').textContent = [init.categoryFull || draft.category, draft.address, draft.phone].filter(Boolean).join(' · ');
  }
  $('#fName').value = draft.name;
  $('#fCategory').value = draft.category;
  $('#fDate').value = draft.visitedAt;
  $('#fMemo').value = draft.memo;
  renderRaters();
  updateLocText();
  draftMarker = new maplibregl.Marker({ draggable: !fromKakao, color: '#E85A3A' }).setLngLat([draft.lng, draft.lat]).addTo(map);
  draftMarker.on('dragend', () => {
    const ll = draftMarker.getLngLat();
    draft.lat = ll.lat; draft.lng = ll.lng; draft.source = 'drag'; draft.address = '';
    updateLocText();
  });
  map.easeTo({ center: [draft.lng, draft.lat], zoom: Math.max(map.getZoom(), 15), offset: [0, -200], duration: 500 });
  openSheet('sheetAdd');
}
function updateLocText() {
  if (!draft) return;
  const t = {
    center: '지도 중앙 · 핀을 끌어 옮길 수 있어요',
    gps: '현재 위치',
    search: draft.address || '검색한 위치',
    drag: '직접 옮긴 위치',
    edit: draft.address || '저장된 위치',
  }[draft.source] || '';
  $('#locText').textContent = t;
}
function clearDraft() {
  if (draftMarker) { draftMarker.remove(); draftMarker = null; }
  draft = null;
}
// 줄 순서: 나 → 이미 점수가 있는 다른 사람들 → 이 폰에서 추가한 사람
function draftRows() {
  const r = draft.ratings;
  const others = Object.keys(r).filter((k) => k !== me()).sort((a, b) => a.localeCompare(b, 'ko'));
  for (const n of draft.extra) if (!others.includes(n)) others.push(n);
  return [me()].concat(others);
}
function renderRaters() {
  if (!draft) return;
  const r = draft.ratings;
  const rows = draftRows();
  $('#pairRate').innerHTML = rows.map((name) => {
    const v = r[name] == null ? null : r[name];
    const isMe = name === me();
    const masked = draft.locked && !isMe && v != null;
    const body = masked
      ? '<div class="masked">🙈 매겼어요 · 내 점수를 저장하면 보여요</div>'
      : `<div class="rate-stars" data-user="${esc(name)}">${starsHTML(v)}</div>${v != null ? miniBadge(v, 28) : '<span class="mini-none">–</span>'}`;
    return `<div class="rate-row"><div class="who"><span class="who-dot" style="background:${isMe ? DOT_ME : DOT_OTHER}"></span>${esc(name)}${isMe ? '<span class="me-tag">나</span>' : ''}</div>${body}</div>`;
  }).join('');

  // 같은 폰에서 다른 사람 점수도 넣기
  const others = knownOthers().filter((n) => !rows.includes(n));
  let addHtml = '';
  if (draft.addingOther) {
    addHtml = `<div class="add-other">
      ${others.map((n) => `<button type="button" class="chip" data-other="${esc(n)}">${esc(n)}</button>`).join('')}
      <input id="fOther" type="text" maxlength="6" placeholder="이름" autocomplete="off">
      <button type="button" class="chip on" id="btnOtherOk">추가</button>
    </div>`;
  } else {
    addHtml = `<div class="add-other"><button type="button" class="link" id="btnAddOther">+ 이 폰에서 다른 사람 점수도 넣기</button></div>`;
  }
  $('#pairRate').insertAdjacentHTML('beforeend', addHtml);

  const avg = avgOf(r);
  if (draft.locked) {
    const mine = r[me()];
    $('#avgLine').innerHTML = `${mine != null ? miniBadge(mine, 40) : lockBadge(40)}<div class="avg-text"><div><b>${mine != null ? `내 점수 ${fmtRating(mine)}` : '🙈 아직 비공개'}</b></div><div class="muted">${mine != null ? '저장하면 상대 점수와 평균이 공개돼요' : '별을 눌러 내 점수를 매겨요. 저장하면 상대 점수가 공개돼요'}</div></div>`;
    return;
  }
  let text = '';
  if (avg == null) text = '<span class="muted">별을 눌러 점수를 매겨요</span>';
  else if (r[me()] == null) text = '<span class="muted">내 점수는 아직 없어요</span>';
  $('#avgLine').innerHTML = `${badgeHTML(r, 40)}<div class="avg-text"><div>${avg == null ? '' : `평균 <b>${fmtRating(avg)}</b> · ${ratingLabel(avg)}`}</div><div>${text}</div></div>`;
}
$('#pairRate').addEventListener('click', (e) => {
  if (!draft) return;
  if (e.target.closest('#btnAddOther')) { draft.addingOther = true; renderRaters(); setTimeout(() => { const i = $('#fOther'); if (i) i.focus(); }, 50); return; }
  const chip = e.target.closest('[data-other]');
  if (chip) { addOther(chip.dataset.other); return; }
  if (e.target.closest('#btnOtherOk')) { addOther($('#fOther').value); return; }
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  const name = b.closest('.rate-stars').dataset.user;
  const i = Number(b.dataset.i);
  const rect = b.getBoundingClientRect();
  const half = (e.clientX - rect.left) < rect.width / 2;
  const v = clampRating(half ? i - 0.5 : i);
  if (draft.ratings[name] === v) delete draft.ratings[name]; else draft.ratings[name] = v; // 같은 값 다시 누르면 취소
  renderRaters();
});
$('#pairRate').addEventListener('keydown', (e) => {
  if (e.target && e.target.id === 'fOther' && e.key === 'Enter') { e.preventDefault(); addOther(e.target.value); }
});
function addOther(name) {
  name = String(name || '').trim();
  if (!name) { toast('이름을 적어 주세요'); return; }
  if (name === me()) { toast('그건 내 이름이에요'); return; }
  if (!draft.extra.includes(name)) draft.extra.push(name);
  draft.addingOther = false;
  renderRaters();
}
$('#btnUseGps').addEventListener('click', async () => {
  if (!draft) return;
  try {
    const pos = await getMyPos(10000);
    draft.lat = pos.lat; draft.lng = pos.lng; draft.source = 'gps'; draft.address = '';
    draftMarker.setLngLat([pos.lng, pos.lat]);
    map.easeTo({ center: [pos.lng, pos.lat], zoom: Math.max(map.getZoom(), 16), offset: [0, -200] });
    updateLocText();
  } catch (e) {
    toast(geoErrorText(e));
  }
});
$('#btnCancelAdd').addEventListener('click', closeSheets);
$('#btnSave').addEventListener('click', () => {
  if (!draft) return;
  const name = draft.kakaoId ? draft.name : $('#fName').value.trim();
  if (!name) { toast('이름을 입력해 주세요'); $('#fName').focus(); return; }
  if (avgOf(draft.ratings) == null) { toast('별을 하나라도 눌러야 저장돼요'); return; }
  const now = Date.now();
  // 바뀐 사람의 점수에만 시각을 찍는다 (동기화에서 사람마다 더 최근 점수를 고르는 기준)
  const ratedAt = Object.assign({}, draft.ratedAt);
  for (const n of new Set(Object.keys(draft.origRatings).concat(Object.keys(draft.ratings)))) {
    if (draft.origRatings[n] !== draft.ratings[n]) ratedAt[n] = now;
  }
  const fields = { name, category: $('#fCategory').value.trim(), memo: $('#fMemo').value, visitedAt: $('#fDate').value, lat: draft.lat, lng: draft.lng };
  const o = draft.orig;
  const fieldsChanged = !o || Object.keys(fields).some((k) => String(fields[k]) !== String(o[k] == null ? '' : o[k]));
  const rec = normalizePlace({
    id: draft.id || undefined, kakaoId: draft.kakaoId, name, lat: draft.lat, lng: draft.lng, ratings: draft.ratings, ratedAt,
    category: fields.category, memo: fields.memo, address: draft.address, phone: draft.phone,
    placeUrl: draft.placeUrl, visitedAt: fields.visitedAt, createdAt: draft.createdAt || now,
    updatedAt: (fieldsChanged || !o || !o.updatedAt) ? now : o.updatedAt, // 점수만 바꿨으면 식당 정보의 수정 시각은 그대로
  });
  const idx = places.findIndex((p) => p.id === rec.id);
  if (idx >= 0) places[idx] = rec; else places.push(rec);
  savePlaces();
  closeSheets();
  toast(idx >= 0 ? '수정했어요' : `평균 ${fmtRating(rec.rating)}점으로 저장했어요`);
  openDetail(rec.id);
});

// ---------- 상세 ----------
let detailId = null;
function pairLineHTML(r) {
  const names = orderedRaters(r, false);
  const locked = isLocked(r);
  const parts = names.map((k) => `<span class="mini">${locked ? lockBadge(24) : miniBadge(r[k], 24)}<span class="who-dot" style="background:${k === me() ? DOT_ME : DOT_OTHER}"></span>${esc(k)}</span>`);
  if (r[me()] == null) parts.push('<button type="button" class="link" id="btnRateMe">내 점수 매기기</button>');
  return parts.join('');
}
function openDetail(id) {
  const p = places.find((x) => x.id === id);
  if (!p) return;
  detailId = id;
  $('#dStar').innerHTML = badgeHTML(p.ratings, 54);
  $('#dName').textContent = p.name;
  $('#dSub').textContent = [
    isLocked(p.ratings) ? '내 점수를 매기면 상대 점수가 공개돼요' : `평균 ${fmtRating(p.rating)} · ${ratingLabel(p.rating)}`,
    p.category, regionOf(p),
  ].filter(Boolean).join(' · ');
  $('#dPair').innerHTML = pairLineHTML(p.ratings);
  $('#dMemo').textContent = p.memo || '';
  $('#dMemo').classList.toggle('hidden', !p.memo);
  $('#dMeta').textContent = [p.visitedAt ? `방문 ${p.visitedAt}` : '', p.address, p.phone].filter(Boolean).join(' · ');
  $('#btnRefresh').textContent = p.kakaoId ? '정보 새로고침' : '카카오맵 정보 연결';
  $('#btnRefresh').classList.toggle('hidden', searchProvider() !== 'kakao');
  openSheet('sheetDetail');
}
$('#dPair').addEventListener('click', (e) => {
  if (!e.target.closest('#btnRateMe')) return;
  const p = places.find((x) => x.id === detailId);
  if (p) startDraft(Object.assign({}, p, { source: 'edit' }));
});
$('#btnEdit').addEventListener('click', () => {
  const p = places.find((x) => x.id === detailId);
  if (p) startDraft(Object.assign({}, p, { source: 'edit' }));
});
$('#btnDelete').addEventListener('click', () => {
  const p = places.find((x) => x.id === detailId);
  if (!p) return;
  if (!confirm(`'${p.name}'을(를) 지울까요?`)) return;
  places = places.filter((x) => x.id !== detailId);
  addTomb(p);
  savePlaces();
  closeSheets();
  toast('지웠어요');
});
$('#btnKakao').addEventListener('click', () => {
  const p = places.find((x) => x.id === detailId);
  if (!p) return;
  const url = p.placeUrl || `https://map.kakao.com/?q=${encodeURIComponent(p.name)}`;
  window.open(url, '_blank', 'noopener');
});
// 카카오맵에서 같은 가게를 다시 찾아 이름·주소·전화·링크를 최신으로 맞춘다.
$('#btnRefresh').addEventListener('click', () => {
  const p = places.find((x) => x.id === detailId);
  if (!p) return;
  toast('카카오맵에서 확인 중…');
  kakaoKeyword(p.name, { center: { lat: p.lat, lng: p.lng }, radius: 500, byDistance: true }, (items) => {
    let hit = null;
    if (p.kakaoId) hit = items.find((it) => it.kakaoId === p.kakaoId) || null;
    if (!hit) hit = items.find((it) => it.name === p.name && haversine(p, it) < 150) || null;
    if (!hit && !p.kakaoId && items.length && haversine(p, items[0]) < 80) hit = items[0];
    if (!hit) { toast(p.kakaoId ? '카카오맵에서 못 찾았어요. 폐업했거나 이름이 바뀌었을 수 있어요.' : '근처에서 같은 이름을 못 찾았어요.'); return; }
    const changed = [];
    if (hit.name !== p.name) changed.push('이름');
    if (hit.address && hit.address !== p.address) changed.push('주소');
    if (hit.phone !== p.phone) changed.push('전화');
    if (!p.kakaoId) {
      changed.push('카카오맵 연결');
      if (hit.kakaoId) addTomb(p, { updatedAt: Date.now() - 1 }); // 앱 id 로 올라가 있던 줄은 지운 걸로 (키가 카카오 id 로 바뀜)
    }
    Object.assign(p, {
      kakaoId: hit.kakaoId, name: hit.name, address: hit.address || p.address, phone: hit.phone,
      placeUrl: hit.placeUrl, lat: hit.lat, lng: hit.lng, updatedAt: Date.now(),
    });
    if (!p.category && hit.category) p.category = hit.category;
    savePlaces();
    openDetail(p.id);
    toast(changed.length ? `${changed.join(', ')} 갱신했어요` : '이미 최신이에요');
  }, (e) => { console.warn(e); toast('카카오맵 조회에 실패했어요'); });
});

// ---------- 목록 (구별로 묶기) ----------
const collapsedGroups = new Set();
function placeRow(p) {
  const r = p.ratings;
  const pair = isLocked(r)
    ? `${orderedRaters(r, false).map(esc).join(', ')} 매김 · 내 점수를 매기면 공개`
    : orderedRaters(r, false).map((k) => `${esc(k)} ${fmtRating(r[k])}`).join(' · ');
  const sub = [pair, [p.category, p.memo].filter(Boolean).join(' · ')].filter(Boolean).join('<br>');
  return `<li class="p-item" data-id="${esc(p.id)}">${badgeHTML(r, 36)}
    <div class="p-body"><div class="p-name">${esc(p.name)}</div><div class="p-sub">${sub}</div></div></li>`;
}
function renderList() {
  const min = Number(settings.minRating) || 0;
  const lockRank = (p) => (isLocked(p.ratings) ? 1 : 0);
  // 내 점수가 없는 곳을 맨 위에 (매겨야 하니까), 그다음 평균 높은 순
  const arr = places.filter(shownByFilter).sort((a, b) => (lockRank(b) - lockRank(a)) || (b.rating - a.rating) || (b.updatedAt - a.updatedAt));
  $('#listCount').textContent = `${arr.length}곳`;
  renderFilterChips();
  if (!arr.length) {
    $('#plist').innerHTML = '<li class="p-empty">아직 없어요. 검색해서 첫 별점을 등록해요.</li>';
    return;
  }
  const groups = new Map();
  for (const p of arr) {
    const g = regionOf(p);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  const order = Array.from(groups.entries())
    .sort((a, b) => (b[1].length - a[1].length) || a[0].localeCompare(b[0], 'ko'));
  $('#plist').innerHTML = order.map(([g, items]) => {
    const best = items.find((p) => !isLocked(p.ratings));
    const closed = collapsedGroups.has(g);
    return `<li class="grp${closed ? ' closed' : ''}" data-g="${esc(g)}">
      <div class="grp-head">
        <span class="grp-name">${esc(g)}</span>
        <span class="grp-count">${items.length}곳${best ? ` · 최고 ${fmtRating(best.rating)}` : ''}</span>
        <button class="grp-map" data-g="${esc(g)}" type="button">지도</button>
        <span class="grp-chev" aria-hidden="true"></span>
      </div>
      <ul class="grp-items">${items.map(placeRow).join('')}</ul>
    </li>`;
  }).join('');
}
$('#plist').addEventListener('click', (e) => {
  const mapBtn = e.target.closest('.grp-map');
  if (mapBtn) {
    const g = mapBtn.dataset.g;
    const bounds = guBounds(g);
    if (bounds) {
      map.fitBounds(bounds, { padding: { top: 90, bottom: 40, left: 30, right: 30 }, duration: 700 });
    } else {
      const items = places.filter((p) => regionOf(p) === g);
      if (items.length) {
        const b = new maplibregl.LngLatBounds();
        for (const p of items) b.extend([p.lng, p.lat]);
        map.fitBounds(b, { padding: 100, maxZoom: 15, duration: 700 });
      }
    }
    closeSheets();
    return;
  }
  const head = e.target.closest('.grp-head');
  if (head) {
    const li = head.closest('.grp');
    const g = li.dataset.g;
    if (collapsedGroups.has(g)) collapsedGroups.delete(g); else collapsedGroups.add(g);
    li.classList.toggle('closed');
    return;
  }
  const row = e.target.closest('.p-item[data-id]');
  if (!row) return;
  const p = places.find((x) => x.id === row.dataset.id);
  if (!p) return;
  map.flyTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 15), offset: [0, -100] });
  openDetail(p.id);
});
$('#chips').addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (c) setMinRating(c.dataset.min);
});
$('#btnList').addEventListener('click', () => { renderList(); openSheet('sheetList'); });

// ---------- 설정 ----------
function renderSearchSourceHint() {
  const p = searchProvider();
  $('#sKakao').placeholder = DEFAULT_KAKAO_KEY ? '기본 키(config.js) 사용 중 · 바꾸려면 입력' : '카카오 JavaScript 키';
  $('#searchSourceHint').textContent = p === 'kakao'
    ? (settings.kakaoKey ? '카카오맵 데이터로 검색해요. 이 키는 이 기기에만 저장돼요.' : '카카오맵 데이터로 검색해요. config.js의 기본 키를 쓰고 있어요.')
    : (p === 'osm' ? 'OpenStreetMap으로 검색 중이에요. 한국 식당은 카카오 키를 넣는 게 훨씬 잘 나와요.' : '검색을 쓰려면 카카오 JavaScript 키가 필요해요.');
}
$('#btnSettings').addEventListener('click', () => {
  $('#sStyle').value = settings.style;
  $('#sGu').checked = settings.showGu !== false;
  $('#sRoads').checked = !!settings.showRoads;
  $('#sMe').value = settings.me || '';
  $('#sKakao').value = settings.kakaoKey || '';
  renderSearchSourceHint();
  $('#sSyncUrl').value = settings.syncUrl || '';
  $('#sSyncUrl').placeholder = DEFAULT_SYNC_URL ? '기본 주소(config.js) 사용 중 · 바꾸려면 입력' : 'https://script.google.com/macros/s/…/exec';
  $('#sSyncToken').value = settings.syncToken || '';
  $('#sAutoSync').checked = settings.autoSync !== false;
  renderSyncStatus();
  openSheet('sheetSettings');
});
$('#btnCloseSettings').addEventListener('click', closeSheets);
$('#btnOpenSetup').addEventListener('click', openSetup);
$('#sMe').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  if (!v) { e.target.value = settings.me; toast('이름은 비울 수 없어요'); return; }
  const prev = settings.me;
  settings.me = v;
  saveSettings();
  renameUser(prev, v);
  savePlaces();
  toast(`이제 ${v}(으)로 매겨요`);
});
$('#sStyle').addEventListener('change', () => {
  settings.style = $('#sStyle').value;
  saveSettings();
  map.setStyle(STYLE_URLS[settings.style]);
});
$('#sGu').addEventListener('change', () => { settings.showGu = $('#sGu').checked; saveSettings(); applyLayerToggles(); });
$('#sRoads').addEventListener('change', () => { settings.showRoads = $('#sRoads').checked; saveSettings(); applyLayerToggles(); });
$('#sKakao').addEventListener('change', () => {
  applyKakaoKey($('#sKakao').value);
  renderSearchSourceHint();
  toast(settings.kakaoKey ? '입력한 키로 검색해요' : (DEFAULT_KAKAO_KEY ? '기본 키로 검색해요' : '카카오 키를 지웠어요'));
});
$('#btnExport').addEventListener('click', () => {
  const data = { app: 'starmap', version: 4, exportedAt: new Date().toISOString(), me: settings.me, places };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `starmap-${settings.me || 'export'}-${today()}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
});
$('#btnImport').addEventListener('click', () => $('#fileImport').click());
// 불러오기: 동기화와 같은 규칙(sync/merge.js)으로 합친다. 같은 식당은 카카오 id 기준, 사람별 점수는 각자 최신 것.
function mergePlaces(incoming) {
  const M = window.StarmapMerge;
  const before = new Map(places.map((p) => [M.keyOf(p), canon(p)]));
  const merged = M.mergeSets(places.concat(tombs).map(M.sanitize), incoming.filter(M.valid).map(M.sanitize));
  places = merged.filter((p) => !p.deleted).map(normalizePlace);
  tombs = merged.filter((p) => p.deleted).map((p) => Object.assign(normalizePlace(p), { deleted: true }));
  regionCache.clear();
  let added = 0, updated = 0;
  for (const p of places) {
    const prev = before.get(M.keyOf(p));
    if (prev == null) added++; else if (prev !== canon(p)) updated++;
  }
  return { added, updated };
}
$('#fileImport').addEventListener('change', async () => {
  const f = $('#fileImport').files[0];
  if (!f) return;
  try {
    const obj = JSON.parse(await f.text());
    const arr = Array.isArray(obj) ? obj : (obj && Array.isArray(obj.places) ? obj.places : null);
    if (!arr) throw new Error('format');
    const incoming = arr
      .filter((p) => p && p.name && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)))
      .map(normalizePlace);
    const { added, updated } = mergePlaces(incoming);
    savePlaces();
    toast(`${added}곳 추가, ${updated}곳 합쳤어요`);
  } catch (e) {
    console.warn(e);
    toast('파일을 읽을 수 없어요');
  }
  $('#fileImport').value = '';
});
$('#btnWipe').addEventListener('click', () => {
  if (!places.length) { toast('지울 데이터가 없어요'); return; }
  const synced = !!activeSyncUrl();
  const extra = synced ? '\n\n공유 시트는 그대로 두고 이 폰의 자동 동기화만 꺼요. 설정에서 다시 켜거나 "지금 동기화"를 누르면 시트 내용이 다시 들어와요.' : '';
  if (!confirm(`이 폰에 저장된 ${places.length}곳을 모두 지울까요? 되돌릴 수 없어요.${extra}`)) return;
  places = []; tombs = [];
  if (synced) { settings.autoSync = false; saveSettings(); }
  syncState = { lastAt: 0, lastCount: 0, dirty: false, error: '' };
  saveJSON(LS_SYNC, syncState);
  saveJSON(LS_PLACES, places); saveJSON(LS_TOMBS, tombs); // 동기화를 부르지 않고 저장 (부르면 시트 내용이 바로 되돌아옴)
  refreshData();
  closeSheets();
  toast('모두 지웠어요');
});

// ---------- 두 폰 동기화 (구글 시트 + Apps Script) ----------
// 방식: 내 데이터 전부(식당 + 삭제 흔적)를 보내면 서버가 sync/merge.js 규칙으로 합쳐 전체를 돌려준다.
// 저장하고 조금 뒤에, 앱을 다시 앞으로 가져올 때, 그리고 "지금 동기화"를 누를 때 돈다.
const SYNC_FOREGROUND_GAP = 20000; // 앱을 다시 열었을 때 이 시간 안에 했으면 건너뜀
const SYNC_TIMEOUT = 25000;
let syncTimer = null, syncing = false, syncAgain = false;
let localRev = 0; // 사용자가 데이터를 바꾼 횟수. 요청 중에 또 바꿨는지 알아보는 데 쓴다.
let lastLocalSaveAt = 0, lastVerCheckAt = 0;
function activeSyncUrl() { return settings.syncUrl || DEFAULT_SYNC_URL; }
function syncReady() { return !!activeSyncUrl() && !!settings.me; }
function autoSyncOn() { return settings.autoSync !== false && syncReady(); }
function markDirty() {
  localRev++;
  lastLocalSaveAt = Date.now();
  syncState.dirty = true;
  saveJSON(LS_SYNC, syncState);
  if (autoSyncOn()) scheduleSync(1500);
}
function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow(false), ms); }
function kickSync(ms) { if (autoSyncOn()) scheduleSync(ms); }
function touchedAfter(p, t) { return p.updatedAt > t || Object.keys(p.ratedAt || {}).some((n) => p.ratedAt[n] > t); }
// 키 순서와 무관한 비교용 문자열
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
// 지운 식당의 흔적 만들기: 점수는 비우고(사람별 시각은 지금으로), deleted 표시
function addTomb(p, extra) {
  const now = Date.now();
  const ratedAt = {};
  for (const n of Object.keys(p.ratings || {})) ratedAt[n] = now;
  const t = Object.assign(normalizePlace(Object.assign({}, p, { ratings: {}, ratedAt, updatedAt: now })), { deleted: true }, extra || {});
  const k = window.StarmapMerge.keyOf(t);
  tombs = tombs.filter((x) => window.StarmapMerge.keyOf(x) !== k).concat([t]);
}
async function syncRequest(payload) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SYNC_TIMEOUT);
  try {
    // Apps Script 는 preflight(OPTIONS)를 못 받으므로 text/plain 단순 요청으로 보낸다. 응답은 302 → JSON.
    const r = await fetch(activeSyncUrl(), {
      method: 'POST', body: JSON.stringify(payload), redirect: 'follow', signal: ctrl.signal,
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    });
    const text = await r.text();
    try { return JSON.parse(text); } catch (e) { throw new Error(r.ok ? 'notjson' : 'http ' + r.status); }
  } finally { clearTimeout(timer); }
}
// 서버가 돌려준 전체 목록을 내 것으로. 요청을 보낸 뒤에 여기서 바꾼 것만 다시 합친다.
function applySync(res, sentAt) {
  const M = window.StarmapMerge;
  const remote = (res.places || []).filter(M.valid).map(M.sanitize);
  const touched = places.concat(tombs).filter((p) => touchedAfter(p, sentAt)).map(M.sanitize);
  const beforeMap = new Map(places.map((p) => [M.keyOf(p), p]));
  const merged = M.mergeSets(remote, touched);
  const openDetailKey = detailId && !$('#sheetDetail').classList.contains('hidden')
    ? (places.find((p) => p.id === detailId) ? M.keyOf(places.find((p) => p.id === detailId)) : null) : null;
  places = merged.filter((p) => !p.deleted).map(normalizePlace);
  tombs = merged.filter((p) => p.deleted).map((p) => Object.assign(normalizePlace(p), { deleted: true }));
  saveJSON(LS_PLACES, places); saveJSON(LS_TOMBS, tombs);
  regionCache.clear();
  refreshData();
  if (openDetailKey) { // 상세를 보고 있었으면 같은 식당으로 다시 (id 가 바뀌었을 수 있음)
    const np = places.find((p) => M.keyOf(p) === openDetailKey);
    if (np) openDetail(np.id); else closeSheets();
  }
  // 무엇이 들어왔는지 한 줄로 (토스트용)
  const news = [];
  for (const p of places) {
    const prev = beforeMap.get(M.keyOf(p));
    const locked = isLocked(p.ratings); // 내 점수가 없는 곳은 토스트에도 상대 점수를 안 보여 준다
    const who = raterNames(p.ratings).filter((n) => !prev || prev.ratings[n] !== p.ratings[n])
      .map((n) => (locked ? `${n} 매김` : `${n} ${fmtRating(p.ratings[n])}`));
    if (!prev || who.length || canon(prev) !== canon(p)) news.push({ name: p.name, who, locked });
  }
  const removed = Array.from(beforeMap.keys()).filter((k) => !places.some((p) => M.keyOf(p) === k)).length;
  if (news.length === 1) {
    const n = news[0];
    if (!n.who.length) return `${n.name} 정보가 바뀌었어요`;
    return `새 점수 · ${n.name}: ${n.who.join(', ')}${n.locked ? ' (내 점수를 매기면 공개)' : ''}`;
  }
  if (news.length > 1) return `시트에서 ${news.length}곳 업데이트`;
  if (removed) return `다른 폰에서 ${removed}곳을 지웠어요`;
  return '';
}
async function syncNow(manual) {
  if (!syncReady()) { if (manual) toast(settings.me ? '동기화 주소를 먼저 넣어 주세요' : '먼저 내 이름을 정해 주세요'); return; }
  if (syncing) { syncAgain = true; return; }
  clearTimeout(syncTimer);
  syncing = true;
  renderSyncStatus('syncing');
  const sentAt = Date.now(), revAtSend = localRev;
  try {
    const res = await syncRequest({ op: 'sync', token: settings.syncToken || '', me: settings.me, places, tombs });
    if (!res || !res.ok) throw new Error((res && res.error) || 'bad');
    const newsText = applySync(res, sentAt);
    syncState.lastAt = Date.now(); syncState.lastCount = places.length; syncState.error = '';
    syncState.ver = res.ver != null ? String(res.ver) : '';
    lastVerCheckAt = Date.now();
    if (localRev === revAtSend) syncState.dirty = false;
    saveJSON(LS_SYNC, syncState);
    if (manual) toast(`동기화 완료 · ${places.length}곳`);
    else if (newsText) toast(newsText);
  } catch (e) {
    console.warn('sync', e);
    syncState.error = syncErrorText(e);
    saveJSON(LS_SYNC, syncState);
    if (manual) toast(syncState.error);
  } finally {
    syncing = false;
    renderSyncStatus();
    if (syncAgain) { syncAgain = false; scheduleSync(2000); }
    else if (syncState.dirty && !syncState.error && autoSyncOn()) scheduleSync(2000); // 요청 중에 또 저장했으면 한 번 더
  }
}
function syncErrorText(e) {
  const m = String((e && e.message) || e);
  if (m === 'token') return '비밀 코드가 달라요. Code.gs 의 TOKEN 과 같게 넣어 주세요.';
  if (m === 'notjson') return '응답이 JSON 이 아니에요. 배포 설정이 "액세스: 모든 사용자"인지 확인해요.';
  if (m === 'busy') return '시트가 바빠요. 잠시 뒤 다시 해요.';
  if (/abort/i.test(m)) return '응답이 너무 늦어요. 인터넷 연결을 확인해요.';
  if (/Failed to fetch|NetworkError|Load failed|network/i.test(m)) return '주소에 연결하지 못했어요. 주소가 …/exec 로 끝나는지, 인터넷이 되는지 확인해요.';
  return `동기화 실패: ${m}`;
}
function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}
function renderSyncStatus(state) {
  const el = $('#syncStatus');
  const url = activeSyncUrl();
  let t;
  if (!url) t = '구글 시트 주소를 넣으면 두 폰의 점수가 자동으로 합쳐져요.';
  else if (state === 'syncing') t = '동기화 중…';
  else if (syncState.error) t = `⚠️ ${syncState.error}`;
  else if (!syncState.lastAt) t = '아직 동기화한 적이 없어요. "지금 동기화"를 눌러 보세요.';
  else t = `마지막 동기화 ${ago(syncState.lastAt)} · ${syncState.lastCount}곳${syncState.dirty ? ' · 보낼 변경 있음' : ''}`;
  el.textContent = t;
  el.classList.toggle('err', !!(url && syncState.error && state !== 'syncing'));
  $('#pill').classList.toggle('syncing', state === 'syncing');
}
// 상대 폰 연결용 링크: 열면 같은 주소가 설정에 들어간다. (#sync=주소&token=코드)
function readSyncLink() {
  const h = location.hash || '';
  if (!/^#sync=/.test(h)) return;
  const q = new URLSearchParams(h.slice(1));
  const url = String(q.get('sync') || '').trim();
  if (/^https?:\/\//.test(url)) {
    settings.syncUrl = url; settings.syncToken = String(q.get('token') || '').trim(); settings.autoSync = true;
    saveSettings();
    syncState.error = ''; saveJSON(LS_SYNC, syncState);
    setTimeout(() => toast('같은 시트에 연결됐어요'), 600);
  }
  history.replaceState(null, '', location.pathname + location.search);
}
async function shareSyncLink() {
  const url = activeSyncUrl();
  if (!url) { toast('먼저 동기화 주소를 넣어 주세요'); return; }
  const link = `${location.origin}${location.pathname}#sync=${encodeURIComponent(url)}${settings.syncToken ? '&token=' + encodeURIComponent(settings.syncToken) : ''}`;
  if (navigator.share) {
    try { await navigator.share({ title: '내 별점 지도', text: '이 링크를 열면 같은 시트에 연결돼요', url: link }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(link); toast('연결 링크를 복사했어요. 카톡으로 보내 주세요'); }
  catch (e) { window.prompt('이 링크를 상대에게 보내 주세요', link); }
}
$('#sSyncUrl').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  if (v && !/^https?:\/\//.test(v)) { toast('https:// 로 시작하는 웹 앱 URL(…/exec)을 넣어 주세요'); return; }
  settings.syncUrl = v; settings.autoSync = true; saveSettings();
  syncState.error = ''; saveJSON(LS_SYNC, syncState);
  $('#sAutoSync').checked = true;
  renderSyncStatus();
  if (activeSyncUrl()) syncNow(true);
});
$('#sSyncToken').addEventListener('change', (e) => { settings.syncToken = e.target.value.trim(); saveSettings(); });
$('#sAutoSync').addEventListener('change', (e) => { settings.autoSync = e.target.checked; saveSettings(); if (settings.autoSync) kickSync(300); });
$('#btnSyncNow').addEventListener('click', () => syncNow(true));
$('#btnSyncShare').addEventListener('click', shareSyncLink);
$('#btnSyncHelp').addEventListener('click', () => openSheet('sheetSyncHelp'));
$('#btnSyncHelpBack').addEventListener('click', () => $('#btnSettings').click());
$('#btnCopyGs').addEventListener('click', async () => {
  try {
    const text = await (await fetch('sync/Code.gs')).text();
    await navigator.clipboard.writeText(text);
    toast('코드를 복사했어요. Apps Script 편집기에 붙여넣어요');
  } catch (e) { window.open('sync/Code.gs', '_blank', 'noopener'); }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && autoSyncOn() && Date.now() - syncState.lastAt > SYNC_FOREGROUND_GAP) scheduleSync(400);
});
// 켜져 있는 동안은 서버의 "바뀜 번호"(ver)만 가볍게 물어보다가, 달라지면 전체를 받아 온다.
// 방금 저장했으면 상대 점수를 기다리는 중일 테니 더 자주 (5초), 평소엔 30초마다.
const POLL_SLOW = 30000, POLL_FAST = 5000, POLL_FAST_WINDOW = 90000, POLL_FALLBACK = 120000;
async function checkVer() {
  lastVerCheckAt = Date.now();
  const url = activeSyncUrl();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url + (url.indexOf('?') === -1 ? '?' : '&') + 'op=ver', { redirect: 'follow', cache: 'no-store', signal: ctrl.signal });
    const j = JSON.parse(await r.text());
    if (!j || !j.ok) return;
    if (j.ver == null) { // 예전 서버 코드(번호 없음): 가끔 전체 동기화로 대신
      if (Date.now() - syncState.lastAt > POLL_FALLBACK) syncNow(false);
      return;
    }
    if (String(j.ver) !== String(syncState.ver || '')) syncNow(false);
  } catch (e) { /* 잠깐 끊긴 건 조용히 넘어감. 다음 번에 다시 */ }
  finally { clearTimeout(timer); }
}
setInterval(() => {
  if (document.visibilityState !== 'visible' || !autoSyncOn() || syncing) return;
  const gap = Date.now() - lastLocalSaveAt < POLL_FAST_WINDOW ? POLL_FAST : POLL_SLOW;
  if (Date.now() - lastVerCheckAt >= gap) checkVer();
}, 1000);
window.addEventListener('online', () => { if (autoSyncOn() && syncState.dirty) scheduleSync(800); });

// ---------- 토스트 / 초기화 ----------
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

readSyncLink();
refreshData();
if (!settings.me) openNames();
else {
  if (!places.length && !syncReady()) setTimeout(() => toast('위의 검색창에서 식당을 찾아 첫 별점을 등록해요'), 1200);
  kickSync(600);
}

if ('serviceWorker' in navigator) {
  const secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (secure) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
})();
