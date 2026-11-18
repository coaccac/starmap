/* 내 별점 지도 — 두 기기의 데이터를 합치는 규칙.
   app.js(폰)와 sync/Code.gs(구글 시트)가 똑같은 코드를 써요. 한쪽을 고치면 다른 쪽도 같이 고쳐요.

   - 같은 식당인지: 카카오맵 id (없으면 앱이 만든 id)
   - 식당 정보(메모·분류·방문일·위치): 더 최근에 수정한 쪽이 이김 (updatedAt)
   - 사람별 점수: 사람마다 따로, 더 최근에 매긴 쪽이 이김 (ratedAt[이름]). 점수를 지운 것도 전파됨
   - 삭제: deleted 표식도 같은 규칙. 삭제한 뒤 다른 폰에서 수정하면 되살아남 */
(function (root) {
  'use strict';
  const STR_FIELDS = ['id', 'kakaoId', 'name', 'category', 'memo', 'address', 'phone', 'placeUrl', 'visitedAt'];

  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
  function keyOf(p) { return p.kakaoId ? 'k:' + p.kakaoId : 'i:' + p.id; }
  function valid(p) {
    return !!p && typeof p === 'object' && !!(p.id || p.kakaoId)
      && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng));
  }
  // 저장/전송 전에 모양을 맞추고 쓸모없는 값은 버린다.
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
    out.id = String(a.id) <= String(b.id) ? a.id : b.id; // 양쪽이 같은 id로 수렴
    const ca = a.createdAt || Infinity, cb = b.createdAt || Infinity;
    out.createdAt = Math.min(ca, cb) === Infinity ? Math.max(ua, ub) : Math.min(ca, cb);
    out.updatedAt = Math.max(ua, ub);
    out.deleted = !!w.deleted;
    return out;
  }
  // base 와 incoming 을 합친 전체 목록. 둘 다 sanitize 된 레코드여야 한다. 순서와 무관하게 같은 결과.
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

  root.StarmapMerge = { keyOf, valid, sanitize, mergeRecord, mergeSets };
})(typeof self !== 'undefined' ? self : this);
