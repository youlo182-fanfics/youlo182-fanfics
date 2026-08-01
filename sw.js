// Service worker minimal pour Youlo182 (PWA installable)
// Pas de cache agressif : le site se met toujours à jour normalement.
self.addEventListener('install', function(e){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ self.clients.claim(); });
self.addEventListener('fetch', function(e){
  // Laisse passer les requêtes normalement (réseau d'abord, pas de cache figé)
  return;
});
