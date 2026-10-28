// Service worker Youlo182 : app installable + LECTURE HORS-LIGNE.
//
// Principe (simple et sans risque de "site figé") :
//  - Page d'accueil, stories.json, chapitres : RÉSEAU D'ABORD. Avec internet, on a
//    toujours la dernière version ; le cache ne sert que si internet est coupé.
//  - Images (couvertures, assets) : affichées depuis le cache (rapide) puis remises
//    à jour en arrière-plan.
//  - Firebase, Google, admin.html, write.html : jamais touchés.
//
// Pour forcer tout le monde à repartir de zéro : changer le numéro de SHELL_CACHE.
const SHELL_CACHE = 'youlo182-shell-v1';
const STORY_CACHE = 'youlo182-stories';   // chapitres + couvertures (gardé d'une version à l'autre)
const SHELL_FILES = ['/', '/stories.json', '/firebase-config.js', '/manifest.json', '/assets/icon-192.png'];

self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(SHELL_CACHE).then(function(c){
      return Promise.all(SHELL_FILES.map(function(u){ return c.add(u).catch(function(){}); }));
    }).then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.map(function(k){
        if(k !== SHELL_CACHE && k !== STORY_CACHE) return caches.delete(k);
      }));
    }).then(function(){ return self.clients.claim(); })
  );
});

function okToStore(res){ return res && res.ok && !res.redirected && res.type === 'basic'; }

// Réseau d'abord, cache en secours (key = clé de rangement, ex. "/" pour la page d'accueil)
// Si le réseau ne répond pas en 4 s (connexion qui "rame"), on sert la copie en cache.
async function networkFirst(e, req, cacheName, key){
  const cache = await caches.open(cacheName);
  const net = fetch(req).then(function(res){
    if(!okToStore(res)) return res;
    return cache.put(key || req, res.clone()).then(function(){ return res; }, function(){ return res; });
  });
  e.waitUntil(net.catch(function(){}));   // laisse le temps de ranger la copie en cache
  try{
    const slow = new Promise(function(resolve){
      setTimeout(function(){ cache.match(key || req, { ignoreSearch: true }).then(resolve); }, 4000);
    });
    const first = await Promise.race([net, slow.then(function(hit){ return hit || net; })]);
    return first;
  }catch(err){
    const hit = await cache.match(key || req, { ignoreSearch: true });
    if(hit) return hit;
    throw err;
  }
}
// Cache d'abord (rapide), mise à jour discrète en arrière-plan
async function staleWhileRevalidate(e, req, cacheName){
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const update = fetch(req).then(function(res){ if(okToStore(res)) return cache.put(req, res.clone()).then(function(){ return res; }); return res; }).catch(function(){ return null; });
  e.waitUntil(update);
  if(hit) return hit;
  const res = await update;
  return res || Response.error();
}

self.addEventListener('fetch', function(e){
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  if(url.origin !== self.location.origin) return;            // Firebase, Google Fonts... : on ne touche pas
  const p = url.pathname;
  if(p.startsWith('/admin') || p.startsWith('/write') || p === '/sw.js' || p.startsWith('/s/') || p.startsWith('/manifest-admin')) return;

  if(req.mode === 'navigate'){
    if(p === '/' || p === '/index.html' || p === '/index') e.respondWith(networkFirst(e, req, SHELL_CACHE, '/'));
    return;
  }
  if(p.startsWith('/stories/')){
    if(p.endsWith('.html')) e.respondWith(networkFirst(e, req, STORY_CACHE));
    else e.respondWith(staleWhileRevalidate(e, req, STORY_CACHE));
    return;
  }
  if(p === '/stories.json' || p === '/firebase-config.js' || p === '/manifest.json'){
    e.respondWith(networkFirst(e, req, SHELL_CACHE, p));
    return;
  }
  if(p.startsWith('/assets/')){
    e.respondWith(staleWhileRevalidate(e, req, SHELL_CACHE));
    return;
  }
});
