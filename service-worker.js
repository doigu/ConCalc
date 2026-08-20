// Получаем версию из параметра URL (service-worker.js?v=21)
// Если параметра нет, используем дефолт
const params = new URLSearchParams(self.location.search);
const version = params.get('v') || '1';
const CACHE_PREFIX = 'calc-editor-';
const cacheName = `${CACHE_PREFIX}v${version}`;

// Оболочка приложения — меняется с каждым выпуском, отдаём network-first,
// чтобы обновление доходило до пользователя без ручной очистки кэша.
const appShell = [
  './',
  'index.html',
  'style.css',
  'config.js',
  'ui.js',
  'storage.js',
  'history.js',
  'settings.js',
  'calc.js',
  'update-check.js',
  'main.js'
];

// Статические ассеты — не меняются в пределах версии, отдаём cache-first.
const staticAssets = [
  'manifest.webmanifest',
  'vendor/math.min.js',
  'parser.js',
  'icons/favicon.ico',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

const assets = [...appShell, ...staticAssets];

// Сколько ждать сеть при network-first, прежде чем откатиться на кэш.
const NETWORK_TIMEOUT = 2000;

self.addEventListener('install', event => {
  self.skipWaiting(); // Активировать немедленно
  event.waitUntil(
    caches.open(cacheName)
      .then(cache => {
        console.log(`Кеширование [${cacheName}]`);
        return cache.addAll(assets);
      })
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(clients.claim()); // Захватить контроль над вкладками
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          // Origin doigu.github.io общий для всех Pages-проектов аккаунта —
          // трогаем только свои кэши, чужие (без нашего префикса) не удаляем (issue #3).
          if (cache.startsWith(CACHE_PREFIX) && cache !== cacheName) {
            console.log('Удаление старого кеша:', cache);
            return caches.delete(cache);
          }
        })
      );
    })
  );
});

function rejectAfter(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('network timeout')), ms));
}

// Сеть в приоритете; при удаче обновляет кэш, при таймауте/ошибке — откат на кэш.
// Запрос не отменяется при таймауте: если он всё же дойдёт, кэш обновится и
// свежая версия применится со следующей загрузки.
async function networkFirst(request) {
  const cache = await caches.open(cacheName);
  const network = fetch(request).then(response => {
    if (response && response.ok) cache.put(request, response.clone());
    return response;
  });
  network.catch(() => {}); // не оставлять необработанный reject после гонки

  try {
    return await Promise.race([network, rejectAfter(NETWORK_TIMEOUT)]);
  } catch (err) {
    const cached = await cache.match(request)
      || (request.mode === 'navigate' ? await cache.match('index.html') : null);
    if (cached) return cached;
    throw err;
  }
}

// Кэш в приоритете; при промахе — сеть с дозаписью в кэш.
async function cacheFirst(request) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response && response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // не перехватывать чужой origin

  const scopePath = new URL('./', self.registration.scope).pathname;
  const rel = url.pathname.startsWith(scopePath) ? url.pathname.slice(scopePath.length) : null;
  const isShell = request.mode === 'navigate'
    || (rel !== null && appShell.includes(rel === '' ? './' : rel));

  event.respondWith(isShell ? networkFirst(request) : cacheFirst(request));
});
