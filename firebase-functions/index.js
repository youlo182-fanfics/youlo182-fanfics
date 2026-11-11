// ============================================================================
// Youlo182 : e-mails automatiques "quelqu'un t'a repondu"
// ----------------------------------------------------------------------------
// Le site cree deja une notification (cloche) a chaque reponse :
//   notifications/{uid}/items/{id}  avec type:'reply'
// Cette fonction se declenche sur cette creation et envoie un e-mail au lecteur,
// sauf s'il a decoche "Recevoir un email quand on me repond" (users/{uid}.emailReplies === false).
//
// Garde-fous anti-spam :
//   - 1 e-mail maximum par discussion toutes les 30 minutes pour un meme lecteur
//   - 15 e-mails maximum par jour pour un meme lecteur
//   - on verifie que le commentaire existe vraiment
//
// Secrets (ranges chez Google, jamais dans le code) :
//   GMAIL_APP_PASSWORD : mot de passe d'application du compte youlo182.fanfics@gmail.com
//   UNSUB_KEY          : cle qui signe les liens de desinscription
// ============================================================================
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();

const REGION = "europe-west1";
const SITE = "https://youlo182-fanfics.pages.dev";
const SMTP_USER = "youlo182.fanfics@gmail.com";
const FROM_ADDR = "youlo182.fanfics@gmail.com";
const FROM_NAME = "Youlo182";
const PROJECT = "youlo182-fanfics";
// Compte autrice sur le site, et boite ou elle veut recevoir SES e-mails (pas son adresse perso).
const AUTHOR_EMAIL = "julie.cacciola@gmail.com";
const AUTHOR_INBOX = "youlo182.fanfics@gmail.com";
const MAX_AUTHOR_PER_DAY = 100;
const UNSUB_URL = "https://" + REGION + "-" + PROJECT + ".cloudfunctions.net/unsubscribe";

const THREAD_COOLDOWN_MS = 30 * 60 * 1000;
const MAX_PER_DAY = 15;
// Plafond GLOBAL : Gmail autorise environ 500 envois/jour pour tout le compte (newsletter comprise).
// On garde de la marge pour la newsletter de Julie.
const MAX_GLOBAL_PER_DAY = 300;

const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");
const UNSUB_KEY = defineSecret("UNSUB_KEY");

// Peu d'instances : impossible de faire exploser la facture meme en cas d'abus.
setGlobalOptions({ region: REGION, maxInstances: 2, memory: "256MiB" });

// ---------- petits outils ----------
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function oneLine(s, max) {
  s = String(s == null ? "" : s).replace(/[\r\n]+/g, " ").trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}
function token(uid) {
  return crypto.createHmac("sha256", UNSUB_KEY.value()).update(String(uid)).digest("hex").slice(0, 32);
}
function unsubLink(uid) {
  return UNSUB_URL + "?u=" + encodeURIComponent(uid) + "&t=" + token(uid);
}
function hash(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16);
}

// Titres des histoires, lus depuis stories.json du site (garde en memoire 10 min).
let __stories = null, __storiesAt = 0;
async function storyTitle(bookId, lang) {
  try {
    if (!__stories || Date.now() - __storiesAt > 10 * 60 * 1000) {
      const r = await fetch(SITE + "/stories.json");
      if (r.ok) { __stories = await r.json(); __storiesAt = Date.now(); }
    }
    let found = null;
    (function walk(o) {
      if (found || !o || typeof o !== "object") return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (o.id === bookId && (o.fr || o.en)) { found = o; return; }
      Object.keys(o).forEach(function (k) { walk(o[k]); });
    })(__stories);
    if (found) {
      const t = (found[lang] && found[lang].title) || (found.fr && found.fr.title) || (found.en && found.en.title);
      if (t) return t;
    }
  } catch (e) { logger.warn("stories.json", e.message); }
  return bookId;
}

// Compteur du jour (mailState/{name}) : renvoie false si le plafond est atteint.
async function takeDaily(name, max) {
  const ref = db.doc("mailState/" + name);
  const today = new Date().toISOString().slice(0, 10);
  return db.runTransaction(async (t) => {
    const g = await t.get(ref);
    const d = g.exists ? g.data() : {};
    const count = d.day === today ? (d.count || 0) : 0;
    if (count >= max) return false;
    t.set(ref, { day: today, count: count + 1 });
    return true;
  });
}
function gmailTransport() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user: SMTP_USER, pass: GMAIL_APP_PASSWORD.value().replace(/\s+/g, "") }
  });
}

// ---------- textes FR / EN ----------
function buildMail(o) {
  const en = o.lang === "en";
  const who = o.fromAdmin ? "Youlo182" : (o.fromName || (en ? "Someone" : "Quelqu'un"));
  const where = o.isAbout
    ? (en ? "on the About page" : "sur la page À propos")
    : (en ? ("on “" + o.title + "”, chapter " + o.chNum) : ("sur « " + o.title + " », chapitre " + o.chNum));
  const subject = o.fromAdmin
    ? (en ? "The author replied to you on Youlo182" : "L'autrice t'a répondu sur Youlo182")
    : (en ? (who + " replied to you on Youlo182") : (who + " t'a répondu sur Youlo182"));
  const hello = en ? ("Hi " + o.toName + ",") : ("Coucou " + o.toName + ",");
  const intro = o.fromAdmin
    ? (en ? ("The author replied in a discussion you're part of " + where + ":") : ("L'autrice a répondu dans une discussion à laquelle tu participes " + where + " :"))
    : (en ? (who + " replied in a discussion you're part of " + where + ":") : (who + " a répondu dans une discussion à laquelle tu participes " + where + " :"));
  const btn = en ? "See the reply" : "Voir la réponse";
  const auto = en
    ? "This is an automatic message, please do not reply. To answer, go to the website."
    : "Ceci est un message automatique, merci de ne pas y répondre. Pour répondre, rends-toi sur le site.";
  const why = en
    ? "You get this e-mail because you take part in this discussion on Youlo182."
    : "Tu reçois cet e-mail car tu participes à cette discussion sur Youlo182.";
  const stop = en ? "Stop these e-mails" : "Ne plus recevoir ces e-mails";
  const alt = en ? "(you can also change this in “My account” on the website)" : "(tu peux aussi changer ça dans « Mon compte » sur le site)";

  const text = [
    hello, "", intro, "", (en ? ("“" + o.preview + "”") : ("« " + o.preview + " »")), "",
    btn + (en ? ": " : " : ") + o.link, "", "--", auto, why, stop + (en ? ": " : " : ") + o.unsub, alt
  ].join("\n");

  // Mise en page volontairement sobre (moins de risque de spam) : texte simple, un seul lien.
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222;max-width:560px;">' +
    "<p>" + esc(hello) + "</p>" +
    "<p>" + esc(intro) + "</p>" +
    '<p style="margin:0 0 16px;padding-left:12px;border-left:3px solid #ccc;color:#444;"><i>' + esc(o.preview) + "</i></p>" +
    '<p><a href="' + esc(o.link) + '">' + esc(btn) + "</a></p>" +
    '<p style="font-size:12px;color:#777;margin-top:28px;">' + esc(auto) + "<br>" + esc(why) + "<br>" +
    '<a href="' + esc(o.unsub) + '" style="color:#777;">' + esc(stop) + "</a> " + esc(alt) + "</p>" +
    "</div>";

  return { subject, text, html };
}

// ---------- 1) Envoi a la creation d'une notification de reponse ----------
exports.mailOnReply = onDocumentCreated(
  { document: "notifications/{uid}/items/{nid}", secrets: [GMAIL_APP_PASSWORD, UNSUB_KEY] },
  async (event) => {
    const snap = event.data;
    const n = snap && snap.data();
    if (!n || n.type !== "reply") return;
    const uid = event.params.uid;

    // Preference du lecteur (cochee par defaut)
    const uSnap = await db.doc("users/" + uid).get();
    const u = uSnap.exists ? uSnap.data() : {};
    if (u.emailReplies === false) { logger.info("desabonne", uid); return; }

    // Adresse e-mail du compte (source fiable : Firebase Authentication)
    let user;
    try { user = await admin.auth().getUser(uid); } catch (e) { logger.warn("compte introuvable", uid); return; }
    if (!user.email || user.disabled) return;
    const isAuthorTarget = (user.email || "").toLowerCase() === AUTHOR_EMAIL;
    const toAddr = isAuthorTarget ? AUTHOR_INBOX : user.email;

    // Le commentaire existe-t-il vraiment ? (protege contre les fausses notifications)
    const isAbout = !!n.isAbout || n.bookId === "about";
    const lang = n.lang === "en" ? "en" : "fr";
    const ch = typeof n.ch === "number" ? n.ch : parseInt(n.ch, 10) || 0;
    const key = isAbout ? "about" : (n.bookId + "_" + lang + "_" + ch);
    if (!n.commentId) return;
    const parent = await db.doc("comments/" + key + "/items/" + n.commentId).get();
    if (!parent.exists) { logger.warn("commentaire introuvable", key, n.commentId); return; }

    // Anti-spam : 1 mail / discussion / 30 min, 15 mails / jour
    const thread = hash(key + "/" + n.commentId);
    const stateRef = db.doc("mailState/" + uid);
    const today = new Date().toISOString().slice(0, 10);
    const ok = await db.runTransaction(async (t) => {
      const s = await t.get(stateRef);
      const d = s.exists ? s.data() : {};
      const threads = d.threads || {};
      const count = d.day === today ? (d.count || 0) : 0;
      const last = threads[thread] || 0;
      if (Date.now() - last < THREAD_COOLDOWN_MS) return false;
      if (count >= MAX_PER_DAY) return false;
      // on ne garde que les discussions recentes (le document reste petit)
      const keep = {};
      Object.keys(threads).forEach(function (k) { if (Date.now() - threads[k] < 7 * 24 * 3600 * 1000) keep[k] = threads[k]; });
      keep[thread] = Date.now();
      t.set(stateRef, { threads: keep, day: today, count: count + 1 });
      return true;
    });
    if (!ok) { logger.info("limite anti-spam atteinte", uid); return; }
    if (!(await takeDaily("_global", MAX_GLOBAL_PER_DAY))) { logger.warn("plafond global du jour atteint (" + MAX_GLOBAL_PER_DAY + ")"); return; }

    const title = isAbout ? "" : await storyTitle(n.bookId, lang);
    const link = isAbout
      ? (SITE + "/?about=1&c=" + encodeURIComponent(n.commentId) + "&lang=" + lang)
      : (SITE + "/?story=" + encodeURIComponent(n.bookId) + "&lang=" + lang + "&ch=" + ch + "&c=" + encodeURIComponent(n.commentId));
    const unsub = unsubLink(uid);
    const toName = oneLine(u.displayName || user.displayName || (lang === "en" ? "reader" : "lectrice"), 40);

    const mail = buildMail({
      lang, isAbout, title, chNum: ch + 1, link, unsub, toName,
      fromName: oneLine(n.fromName, 40), fromAdmin: !!n.fromAdmin,
      preview: oneLine(n.preview, 200)
    });

    const transporter = gmailTransport();
    try {
      await transporter.sendMail({
        from: { name: FROM_NAME, address: FROM_ADDR },
        to: toAddr,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        headers: {
          "List-Unsubscribe": "<" + unsub + ">",
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          "Auto-Submitted": "auto-generated"
        }
      });
      logger.info("mail envoye", uid);
    } catch (e) {
      logger.error("envoi impossible", e.message);
    }
  }
);

// ---------- 1 bis) Nouveau commentaire -> e-mail a l'autrice (boite youlo182.fanfics) ----------
// Seulement les NOUVEAUX commentaires (pas les reponses : celles-ci passent par mailOnReply,
// et l'autrice ne les recoit que si elle participe a la discussion).
exports.mailAuthorOnComment = onDocumentCreated(
  { document: "comments/{key}/items/{cid}", secrets: [GMAIL_APP_PASSWORD] },
  async (event) => {
    const c = event.data && event.data.data();
    if (!c || c.admin) return;                       // commentaire de l'autrice elle-meme
    if (c.uid) {
      try {
        const au = await admin.auth().getUserByEmail(AUTHOR_EMAIL);
        if (au.uid === c.uid) return;
      } catch (e) { /* compte autrice introuvable : on continue */ }
    }
    if (!(await takeDaily("_author", MAX_AUTHOR_PER_DAY))) { logger.warn("plafond autrice du jour atteint"); return; }
    if (!(await takeDaily("_global", MAX_GLOBAL_PER_DAY))) { logger.warn("plafond global du jour atteint"); return; }

    const key = event.params.key, cid = event.params.cid;
    const isAbout = key === "about";
    const m = key.match(/^(.*)_(fr|en)_(\d+)$/);
    const bookId = isAbout ? "about" : (m ? m[1] : key);
    const lang = m ? m[2] : "fr";
    const ch = m ? parseInt(m[3], 10) : 0;
    const title = isAbout ? "" : await storyTitle(bookId, lang);
    const where = isAbout ? "la page À propos" : ("« " + title + " », chapitre " + (ch + 1) + " (" + lang.toUpperCase() + ")");
    const link = isAbout
      ? (SITE + "/?about=1&c=" + encodeURIComponent(cid) + "&lang=" + lang)
      : (SITE + "/?story=" + encodeURIComponent(bookId) + "&lang=" + lang + "&ch=" + ch + "&c=" + encodeURIComponent(cid));
    const who = oneLine(c.name || "Quelqu'un", 40);
    const txt = oneLine(c.text, 600);
    const quote = c.quote ? oneLine(c.quote, 200) : "";

    const subject = "Nouveau commentaire de " + who + " sur " + (isAbout ? "la page À propos" : title);
    const text = [
      who + " a laissé un commentaire sur " + where + " :", "",
      (quote ? ("Passage : « " + quote + " »\n") : "") + "« " + txt + " »", "",
      "Voir le commentaire : " + link
    ].join("\n");
    const html =
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222;max-width:560px;">' +
      "<p><b>" + esc(who) + "</b> a laissé un commentaire sur " + esc(where) + " :</p>" +
      (quote ? '<p style="margin:0 0 8px;color:#777;font-size:13px;">Passage : <i>' + esc(quote) + "</i></p>" : "") +
      '<p style="margin:0 0 16px;padding-left:12px;border-left:3px solid #ccc;color:#444;"><i>' + esc(txt) + "</i></p>" +
      '<p><a href="' + esc(link) + '">Voir le commentaire</a></p>' +
      "</div>";
    try {
      await gmailTransport().sendMail({
        from: { name: FROM_NAME, address: FROM_ADDR },
        to: AUTHOR_INBOX, subject, text, html,
        headers: { "Auto-Submitted": "auto-generated" }
      });
      logger.info("mail autrice envoye", key, cid);
    } catch (e) { logger.error("envoi autrice impossible", e.message); }
  }
);

// ---------- 2) Lien "Ne plus recevoir ces e-mails" ----------
// GET  : page de confirmation (un bouton), pour eviter qu'un antivirus qui "clique" les liens desinscrive par erreur
// POST : desinscription (bouton de la page, ou desinscription en un clic de Gmail)
function page(title, body) {
  return '<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>" + esc(title) + "</title></head>" +
    '<body style="margin:0;background:#f6eef1;font-family:Georgia,serif;">' +
    '<div style="max-width:460px;margin:40px auto;background:#fff;border-radius:14px;padding:28px 24px;border:1px solid #ead3db;text-align:center;">' +
    '<div style="font-size:22px;color:#b03d5e;margin-bottom:14px;">Youlo182</div>' + body +
    '<p style="margin-top:22px;"><a href="' + SITE + '" style="color:#b03d5e;">Retour au site / Back to the website</a></p>' +
    "</div></body></html>";
}
exports.unsubscribe = onRequest({ secrets: [UNSUB_KEY], invoker: "public" }, async (req, res) => {
  const uid = String((req.query && req.query.u) || "");
  const t = String((req.query && req.query.t) || "");
  let valid = false;
  try {
    valid = !!uid && t.length === 32 && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token(uid)));
  } catch (e) { valid = false; }
  res.set("Cache-Control", "no-store");
  if (!valid) {
    res.status(400).send(page("Lien invalide", "<p>Ce lien n'est pas valide. / This link is not valid.</p>"));
    return;
  }
  if (req.method === "POST") {
    await db.doc("users/" + uid).set({ emailReplies: false }, { merge: true });
    res.send(page("C'est noté", "<p>C'est noté, tu ne recevras plus d'e-mails quand on te répond.</p>" +
      "<p style=\"color:#8a7a80;font-size:14px;\">Done, you will no longer get e-mails when someone replies to you.</p>" +
      "<p style=\"color:#8a7a80;font-size:13px;\">Tu peux les réactiver dans « Mon compte » sur le site.</p>"));
    return;
  }
  const action = UNSUB_URL + "?u=" + encodeURIComponent(uid) + "&t=" + encodeURIComponent(t);
  res.send(page("Ne plus recevoir ces e-mails",
    "<p>Tu ne veux plus recevoir d'e-mail quand quelqu'un te répond ?</p>" +
    '<p style="color:#8a7a80;font-size:14px;">Stop getting e-mails when someone replies to you?</p>' +
    '<form method="post" action="' + esc(action) + '">' +
    '<button type="submit" style="background:#b03d5e;color:#fff;border:none;padding:12px 22px;border-radius:999px;font-size:15px;cursor:pointer;">Confirmer / Confirm</button>' +
    "</form>"));
});

// ============================================================================
// COMPTEURS / INDEX DES COMMENTAIRES (economie de lectures)
// ----------------------------------------------------------------------------
// Pour chaque chapitre (et la page A propos), on tient a jour UN document resume :
//   stats/c_{key}  =  { v:1, n, items:[ {id, name, uid, text, quote, ts, admin, edited,
//                                        replies:[{id, name, uid, text, ts, admin, edited}]} ] }
// Le site lit ce seul document (1 lecture) au lieu de tous les commentaires + reponses.
// stats/* est deja lisible par tout le monde et seule l'autrice / le serveur peut y ecrire
// autre chose que "totals" : aucune regle Firestore a changer.
// Reconstruit a chaque creation / modification / suppression d'un commentaire ou d'une reponse.
// ============================================================================
const { onDocumentWritten } = require("firebase-functions/v2/firestore");

function pick(d, keys) {
  const o = {};
  keys.forEach((k) => { if (d[k] !== undefined && d[k] !== null) o[k] = d[k]; });
  return o;
}
function tsMs(t) { return t && t.toMillis ? t.toMillis() : 0; }

async function rebuildIndex(key) {
  const idxRef = db.collection("stats").doc("c_" + key);
  const itemsCol = db.collection("comments").doc(key).collection("items");
  await db.runTransaction(async (tx) => {
    await tx.get(idxRef);   // verrou : deux reconstructions simultanees ne s'ecrasent pas
    const snap = await tx.get(itemsCol);
    const items = await Promise.all(snap.docs.map(async (d) => {
      const rs = await tx.get(d.ref.collection("replies"));
      const replies = rs.docs
        .map((r) => Object.assign({ id: r.id }, pick(r.data(), ["name", "uid", "text", "ts", "admin", "edited"])))
        .sort((a, b) => tsMs(a.ts) - tsMs(b.ts));
      return Object.assign({ id: d.id }, pick(d.data(), ["name", "uid", "text", "quote", "ts", "admin", "edited"]), { replies });
    }));
    items.sort((a, b) => tsMs(b.ts) - tsMs(a.ts));
    let out = { v: 1, n: items.length, at: admin.firestore.FieldValue.serverTimestamp(), items };
    // Limite Firestore : 1 Mo par document. Au-dela (enorme fil), on laisse le site lire a l'ancienne.
    if (Buffer.byteLength(JSON.stringify(items)) > 900000) {
      out = { v: 1, n: items.length, at: admin.firestore.FieldValue.serverTimestamp(), tooBig: true };
    }
    if (items.length === 0) tx.delete(idxRef); else tx.set(idxRef, out);
  });
}

exports.indexOnComment = onDocumentWritten("comments/{key}/items/{cid}", async (event) => {
  try { await rebuildIndex(event.params.key); } catch (e) { logger.error("indexOnComment", event.params.key, e); }
});
exports.indexOnReply = onDocumentWritten("comments/{key}/items/{cid}/replies/{rid}", async (event) => {
  try { await rebuildIndex(event.params.key); } catch (e) { logger.error("indexOnReply", event.params.key, e); }
});

// Reconstruction complete (une fois au depart, ou en secours) :
//   https://europe-west1-youlo182-fanfics.cloudfunctions.net/rebuildCommentIndexes?k=<cle>
// <cle> = HMAC du mot "rebuild" avec UNSUB_KEY (voir ~/.aki/tmp pour la generer).
exports.rebuildCommentIndexes = onRequest({ secrets: [UNSUB_KEY], invoker: "public", timeoutSeconds: 540 }, async (req, res) => {
  const want = crypto.createHmac("sha256", UNSUB_KEY.value()).update("rebuild").digest("hex");
  if ((req.query.k || "") !== want) { res.status(403).send("forbidden"); return; }
  const refs = await db.collection("comments").listDocuments();
  let done = 0; const errors = [];
  for (const r of refs) {
    try { await rebuildIndex(r.id); done++; } catch (e) { errors.push(r.id + ": " + e.message); }
  }
  res.json({ keys: refs.length, done, errors });
});
