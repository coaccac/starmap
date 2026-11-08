/* 앱 껍데기만 캐시. 지도 타일/검색은 항상 네트워크. */
const CACHE = 'starmap-shell-v6';
const SHELL = [
  './', './index.html', './style.css', './config.js', './app.js', './manifest.json',
  './vendor/maplibre-gl.js', './vendor/maplibre-gl.css', './data/seoul-gu.json', './sync/merge.js', './vendor/fonts/NanumSquareNeo-Rg.woff2', './vendor/fonts/NanumSquareNeo-Bd.woff2', './vendor/fonts/NanumSquareNeo-Eb.woff2',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 타일, 검색, 카카오 SDK는 그대로 통과

  // 내 파일: 네트워크 우선, 실패하면 캐시 (오프라인 실행용)
  e.respondWith(fetch(req).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html'))));
});
