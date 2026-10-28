// Cloudflare Pages Function : lien de partage /s/ID
// -------------------------------------------------
// Quand quelqu'un partage https://youlo182-fanfics.pages.dev/s/ID sur Insta,
// Discord, WhatsApp, X... l'aperçu affiche la COUVERTURE, le TITRE et le
// RÉSUMÉ de l'histoire (au lieu de la bannière générique du site).
// Pour un vrai lecteur, la page d'accueil s'ouvre directement sur l'histoire.
//
// - Rien à configurer : Cloudflare détecte ce fichier tout seul.
// - Gratuit : 100 000 appels par jour inclus dans le plan gratuit.
// - Histoire programmée (date de sortie pas encore passée) : on ne révèle
//   ni titre ni couverture, on renvoie vers /?story=ID (message "pas encore dispo").
// - Firebase n'est PAS appelé ici : aucun coût de lecture.

const SITE_NAME = 'Youlo182';
const FALLBACK_IMAGE = '/assets/girls-like-girls-banner.jpeg';

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shorten(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + '...';
}

function redirect(origin, path) {
  return new Response(null, {
    status: 302,
    headers: { Location: origin + path, 'Cache-Control': 'no-store' },
  });
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const origin = url.origin;
  const id = String(params.id || '');

  let data;
  try {
    const res = await env.ASSETS.fetch(new Request(new URL('/stories.json', origin).toString()));
    data = await res.json();
  } catch (e) {
    return redirect(origin, '/');
  }

  const stories = (data && data.stories) || [];
  const story = stories.find((s) => s && s.id === id);
  if (!story) return redirect(origin, '/');

  const storyPath = '/?story=' + encodeURIComponent(id);

  // Histoire programmée : on garde le secret jusqu'à la date de sortie
  if (story.releaseAt) {
    const releaseTs = Date.parse(story.releaseAt);
    if (!isNaN(releaseTs) && Date.now() < releaseTs) return redirect(origin, storyPath);
  }

  const L = story.onlyLang === 'en' || !story.fr ? 'en' : 'fr';
  const info = story[L] || story.fr || story.en || {};
  const title = stripHtml(info.title || id) + ' - ' + SITE_NAME;
  const description = shorten(stripHtml(info.summary || ''), 200) ||
    'Les fanfictions de Julie Cacciola (Youlo182).';
  const cover = String(story.cover || '');
  const image = /^https?:\/\//.test(cover) ? cover
    : origin + (cover ? '/' + encodeURI(cover.replace(/^\/+/, '')) : FALLBACK_IMAGE);
  const pageUrl = origin + '/s/' + encodeURIComponent(id);

  let page;
  try {
    page = await env.ASSETS.fetch(new Request(new URL('/', origin).toString()));
  } catch (e) {
    return redirect(origin, storyPath);
  }
  if (!page.ok) return redirect(origin, storyPath);

  // Juste après <meta charset> : on remplace l'adresse /s/ID par /?story=ID
  // AVANT que le navigateur lise les liens relatifs (manifest, icônes, images).
  // La page d'accueil ouvre ensuite l'histoire toute seule (openStoryFromURL).
  const fixUrl = '<script>try{history.replaceState(null,"",' +
    JSON.stringify(storyPath) + ')}catch(e){}</script>';

  const setContent = (value) => ({
    element(el) { el.setAttribute('content', value); },
  });

  const rewritten = new HTMLRewriter()
    .on('meta[charset]', { element(el) { el.after(fixUrl, { html: true }); } })
    .on('head > title', { element(el) { el.setInnerContent(title); } })
    .on('meta[property="og:type"]', setContent('article'))
    .on('meta[property="og:title"]', setContent(title))
    .on('meta[property="og:description"]', setContent(description))
    .on('meta[property="og:image"]', setContent(image))
    .on('meta[property="og:url"]', setContent(pageUrl))
    .on('meta[name="twitter:title"]', setContent(title))
    .on('meta[name="twitter:description"]', setContent(description))
    .on('meta[name="twitter:image"]', setContent(image))
    .transform(page);

  const headers = new Headers(rewritten.headers);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'public, max-age=300');
  headers.delete('etag');
  headers.delete('content-length');
  return new Response(rewritten.body, { status: 200, headers });
}
