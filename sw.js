/* 离线缓存：第一次打开时把整个应用存到手机里，之后断网也能学。
   应用文件：先用缓存秒开，同时在后台取最新版本，下次打开时生效。
   发音文件：听过一次就永久保存，不再联网。 */
var CACHE = 'indo1000-v1';
var AUDIO = 'indo1000-audio-v1';
var FILES = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'data/words-1.js',
  'data/words-2.js',
  'data/words-3.js',
  'data/words-4.js',
  'data/words-5.js',
  'data/notes-1.js',
  'data/notes-2.js',
  'data/notes-3.js',
  'data/notes-4.js',
  'data/notes-5.js',
  'data/audio.js',
  'manifest.json',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE && k !== AUDIO; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (url.pathname.indexOf('/audio/') >= 0) {
    e.respondWith(
      caches.open(AUDIO).then(function (cache) {
        return cache.match(req.url).then(function (hit) {
          return hit || fetch(req.url).then(function (res) {
            if (res && res.ok) cache.put(req.url, res.clone());
            return res;
          });
        });
      })
    );
    return;
  }

  e.respondWith(
    caches.open(CACHE).then(function (cache) {
      return cache.match(req, { ignoreSearch: true }).then(function (hit) {
        var fresh = fetch(req.url, { cache: 'no-cache' }).then(function (res) {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(function () { return hit; });
        return hit || fresh;
      });
    })
  );
});
