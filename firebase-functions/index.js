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
  const news = String((req.query && req.query.n) || "") === "1";   // lien de la newsletter
  let valid = false;
  try {
    valid = !!uid && t.length === 32 && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(news ? newsToken(uid) : token(uid)));
  } catch (e) { valid = false; }
  res.set("Cache-Control", "no-store");
  if (!valid) {
    res.status(400).send(page("Lien invalide", "<p>Ce lien n'est pas valide. / This link is not valid.</p>"));
    return;
  }
  if (news) {
    if (req.method === "POST") {
      await db.doc("users/" + uid).set({ newsletter: false }, { merge: true });
      res.send(page("C'est noté", "<p>C'est noté, tu ne recevras plus la newsletter des nouvelles histoires.</p>" +
        "<p style=\"color:#8a7a80;font-size:14px;\">Done, you will no longer get the new stories newsletter.</p>" +
        "<p style=\"color:#8a7a80;font-size:13px;\">Tu peux te réinscrire dans « Mon compte » sur le site.</p>"));
      return;
    }
    const act = UNSUB_URL + "?n=1&u=" + encodeURIComponent(uid) + "&t=" + encodeURIComponent(t);
    res.send(page("Newsletter", "<p>Tu ne veux plus recevoir la newsletter des nouvelles histoires ?</p>" +
      '<p style="color:#8a7a80;font-size:14px;">Stop getting the new stories newsletter?</p>' +
      '<form method="post" action="' + esc(act) + '">' +
      '<button type="submit" style="background:#b03d5e;color:#fff;border:none;padding:12px 22px;border-radius:999px;font-size:15px;cursor:pointer;">Confirmer / Confirm</button></form>'));
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

// ============================================================================
// COUPE-CIRCUIT DE FACTURATION
// ----------------------------------------------------------------------------
// Le budget Google Cloud "Firebase Project youlo182-fanfics" (2 EUR / mois) publie
// regulierement la depense du mois sur le sujet Pub/Sub "budget-alerts".
// Si la depense reelle atteint KILL_AT, on previent Julie puis on DETACHE la facturation
// du projet : plus aucun cout possible. Le site statique (Cloudflare) reste en ligne,
// Firebase repasse en mode gratuit limite. Pour reactiver : console Google Cloud > Facturation.
// ============================================================================
const { onMessagePublished } = require("firebase-functions/v2/pubsub");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const KILL_AT = 2;   // euros

exports.billingKillSwitch = onMessagePublished({ topic: "budget-alerts", secrets: [GMAIL_APP_PASSWORD] }, async (event) => {
  let d = {};
  try { d = event.data.message.json || JSON.parse(Buffer.from(event.data.message.data, "base64").toString()); } catch (e) { logger.warn("budget msg", e.message); return; }
  const cost = Number(d.costAmount || 0);
  logger.info("budget", { cost, budget: d.budgetAmount, currency: d.currencyCode });
  if (!(cost >= KILL_AT)) return;
  const st = db.doc("mailState/_billing");
  const month = String(d.costIntervalStart || new Date().toISOString().slice(0, 7));
  const prev = await st.get();
  if (prev.exists && prev.data().cutFor === month) return;   // deja coupe ce mois-ci
  await st.set({ cutFor: month, cost, at: admin.firestore.FieldValue.serverTimestamp() });
  try {
    await gmailTransport().sendMail({
      from: { name: FROM_NAME, address: FROM_ADDR }, to: AUTHOR_INBOX,
      subject: "Youlo182 : facturation Firebase coupee (" + cost.toFixed(2) + " EUR)",
      text: "Coucou Julie,\n\nLa depense Google Cloud du mois a atteint " + cost.toFixed(2) + " EUR (seuil " + KILL_AT + " EUR).\n" +
        "Par securite, la facturation du projet youlo182-fanfics vient d'etre coupee automatiquement : plus aucun cout possible.\n\n" +
        "Le site reste en ligne et lisible. Les e-mails automatiques et les resumes de commentaires sont en pause, et Firebase repasse aux limites gratuites.\n\n" +
        "Pour tout remettre : demande a Aki, ou console Google Cloud > Facturation > Associer un compte de facturation au projet youlo182-fanfics.\n"
    });
  } catch (e) { logger.error("mail killswitch", e.message); }
  const { GoogleAuth } = require("google-auth-library");
  const client = await new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-billing"] }).getClient();
  await client.request({
    url: "https://cloudbilling.googleapis.com/v1/projects/" + PROJECT + "/billingInfo",
    method: "PUT", data: { billingAccountName: "" }
  });
  logger.warn("FACTURATION COUPEE", cost);
});

// ============================================================================
// NEWSLETTER AUTOMATIQUE
// ----------------------------------------------------------------------------
// Toutes les 30 min, on lit stories.json du site :
//  - une histoire avec un DECOMPTE (releaseAt dans le futur, sans noCountdown)
//    -> mail "nouvelle histoire le <date> a <heure>" avec image + resume ;
//  - une histoire toute nouvelle publiee directement (sans decompte)
//    -> mail "nouvelle histoire en ligne".
// Un seul mail par histoire, aux inscrits qui ont coche la newsletter (users.newsletter === true).
// Au tout premier passage, les histoires deja presentes sont juste memorisees (aucun mail).
// Champ optionnel dans stories.json : "mailNote": {"fr": "...", "en": "..."} (petit paragraphe en plus).
// ============================================================================
const NEWS_PER_RUN = 120;

function newsToken(uid) { return token("news:" + uid); }
function newsUnsubLink(uid) { return UNSUB_URL + "?n=1&u=" + encodeURIComponent(uid) + "&t=" + newsToken(uid); }
function absUrl(p) { return SITE + "/" + String(p || "").split("/").map(encodeURIComponent).join("/"); }
function realDate(s) { const t = Date.parse(s || ""); return (t && new Date(t).getUTCFullYear() < 2090) ? t : 0; }
function fmtWhen(ms, en) {
  const o = { timeZone: "Europe/Paris", weekday: "long", day: "numeric", month: "long" };
  const day = new Intl.DateTimeFormat(en ? "en-GB" : "fr-FR", o).format(new Date(ms));
  const p = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ms));
  const h = Number(p.find((x) => x.type === "hour").value), m = p.find((x) => x.type === "minute").value;
  if (en) {
    const h12 = (h % 12) || 12;
    return day + " at " + h12 + (m === "00" ? "" : ":" + m) + (h < 12 ? " AM" : " PM") + " (Paris time)";
  }
  return day + " à " + h + "h" + (m === "00" ? "" : m) + " (heure de Paris)";
}

function buildNews(s, kind, unsub) {
  const fr = s.fr || {}, en = s.en || {};
  const titleFr = fr.title || en.title || s.id, titleEn = en.title || fr.title || s.id;
  const when = realDate(s.releaseAt);
  const link = SITE + "/?story=" + encodeURIComponent(s.id);
  const img = absUrl(s.banner || s.cover);
  const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1);
  const P = {
    fr: {
      hello: "Coucou 💛",
      head: kind === "teaser" ? "📖 Nouvelle histoire le " + fmtWhen(when, false) + " !" : "📖 Nouvelle histoire en ligne !",
      intro: kind === "teaser" ? "Je publie bientôt une toute nouvelle histoire : " + titleFr + "." : "Une toute nouvelle histoire t'attend sur le site : " + titleFr + ".",
      sum: fr.summary || "", note: (s.mailNote && s.mailNote.fr) || "",
      btn: kind === "teaser" ? "Voir l'histoire sur le site" : "Lire maintenant",
      bye: kind === "teaser" ? "J'ai hâte de te la faire découvrir. À très vite ! 🥰💛" : "Bonne lecture ! 🥰💛",
      foot: "Tu reçois ce mail car tu es inscrit·e à ma newsletter sur youlo182-fanfics.pages.dev.",
      stop: "Me désinscrire de la newsletter"
    },
    en: {
      hello: "Hi 💛",
      head: kind === "teaser" ? "📖 New story on " + fmtWhen(when, true) + "!" : "📖 New story online!",
      intro: kind === "teaser" ? "I'm publishing a brand-new story soon: " + titleEn + "." : "A brand-new story is waiting for you on the site: " + titleEn + ".",
      sum: en.summary || "", note: (s.mailNote && s.mailNote.en) || "",
      btn: kind === "teaser" ? "See the story on the site" : "Read it now",
      bye: kind === "teaser" ? "I can't wait for you to read it. See you very soon! 🥰💛" : "Happy reading! 🥰💛",
      foot: "You get this e-mail because you subscribed to my newsletter on youlo182-fanfics.pages.dev.",
      stop: "Unsubscribe from the newsletter"
    }
  };
  const subject = kind === "teaser"
    ? "Nouvelle histoire le " + fmtWhen(when, false).replace(" (heure de Paris)", "") + " : " + titleFr
    : "Nouvelle histoire en ligne : " + titleFr;
  function part(L) {
    const x = P[L];
    return '<p>' + esc(x.hello) + '</p>' +
      '<p style="font-size:17px;"><b>' + esc(x.head) + '</b></p>' +
      '<p>' + esc(x.intro) + '</p>' +
      (x.sum ? '<p style="padding-left:12px;border-left:3px solid #e6c9d3;color:#444;"><i>' + esc(x.sum) + '</i></p>' : '') +
      (x.note ? '<p>' + esc(x.note).replace(/\n/g, "<br>") + '</p>' : '') +
      '<p><a href="' + esc(link) + '" style="color:#b03d5e;font-weight:bold;">👉 ' + esc(x.btn) + '</a></p>' +
      '<p>' + esc(x.bye) + '</p><p>xx Youlo182 aka Julie</p>';
  }
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#222;max-width:560px;">' +
    '<p style="font-size:12px;color:#777;">English below</p>' +
    '<p><a href="' + esc(link) + '"><img src="' + esc(img) + '" alt="' + esc(titleFr) + '" style="width:100%;max-width:560px;border-radius:10px;display:block;"></a></p>' +
    part("fr") + '<hr style="border:none;border-top:1px solid #ddd;margin:28px 0;">' + part("en") +
    '<p style="font-size:12px;color:#777;margin-top:28px;">' + esc(P.fr.foot) + '<br>' + esc(P.en.foot) + '<br>' +
    '<a href="' + esc(unsub) + '" style="color:#777;">' + esc(P.fr.stop) + ' / ' + esc(P.en.stop) + '</a></p></div>';
  function txt(L) {
    const x = P[L];
    return [x.hello, "", x.head, "", x.intro, "", x.sum, x.note ? "\n" + x.note : "", "", x.btn + " : " + link, "", x.bye, "", "xx Youlo182 aka Julie"].join("\n");
  }
  const text = "English below\n\n" + txt("fr") + "\n\n-----\n\n" + txt("en") + "\n\n--\n" + P.fr.foot + "\n" + P.fr.stop + " : " + unsub;
  return { subject, html, text };
}

async function sendNews(transporter, s, kind, toAddr, uid) {
  const unsub = uid ? newsUnsubLink(uid) : SITE;
  const m = buildNews(s, kind, unsub);
  await transporter.sendMail({
    from: { name: FROM_NAME, address: FROM_ADDR }, to: toAddr, subject: m.subject, text: m.text, html: m.html,
    headers: uid ? { "List-Unsubscribe": "<" + unsub + ">", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : {}
  });
}

async function fetchStories() {
  const r = await fetch(SITE + "/stories.json?t=" + Date.now(), { headers: { "Cache-Control": "no-cache" } });
  if (!r.ok) throw new Error("stories.json " + r.status);
  const j = await r.json();
  return Array.isArray(j) ? j : (j.stories || []);
}
function hasChapters(s) { return ["fr", "en"].some((l) => s[l] && Array.isArray(s[l].chapters) && s[l].chapters.length > 0); }

exports.newsletterCheck = onSchedule({ schedule: "every 30 minutes", timeZone: "Europe/Paris", secrets: [GMAIL_APP_PASSWORD, UNSUB_KEY], timeoutSeconds: 540 }, async () => {
  const stories = await fetchStories();
  const now = Date.now();
  const stRef = db.doc("mailState/_news");
  const st = (await stRef.get()).data() || {};
  const known = st.known || {};
  if (!st.init) {   // premier passage : on memorise l'existant, aucun mail
    stories.forEach((s) => { known[s.id] = "existing"; });
    await stRef.set({ init: true, known });
    logger.info("newsletter init", stories.length);
    return;
  }
  // Que faut-il annoncer ?
  const todo = [];
  stories.forEach((s) => {
    const k = known[s.id];
    const when = realDate(s.releaseAt);
    const isTeaser = when > now && !s.noCountdown;
    if (isTeaser && k !== "teaser" && k !== "live") todo.push({ s, kind: "teaser" });
    else if ((!k || k === "waiting") && !isTeaser && hasChapters(s) && (!when || when <= now)) todo.push({ s, kind: "live" });
    else if (!k && (s.noCountdown || !hasChapters(s))) known[s.id] = "waiting";   // pas encore prete
  });
  // Securite : plus de 2 histoires d'un coup = sans doute une reorganisation du site, on demande a Julie.
  const fresh = todo.filter((t) => !(st.sending && st.sending.id === t.s.id));
  if (fresh.length > 2) {
    fresh.forEach((t) => { known[t.s.id] = "skipped"; });
    await stRef.set({ known }, { merge: true });
    await gmailTransport().sendMail({ from: { name: FROM_NAME, address: FROM_ADDR }, to: AUTHOR_INBOX,
      subject: "Youlo182 : newsletter NON envoyee (" + fresh.length + " histoires d'un coup)",
      text: "Coucou Julie,\n\n" + fresh.length + " nouvelles histoires sont apparues d'un coup dans stories.json : " + fresh.map((t) => t.s.id).join(", ") +
        ".\nPar securite, aucune newsletter n'est partie. Demande a Aki si tu veux en envoyer une." });
    return;
  }
  if (!todo.length) { await stRef.set({ known }, { merge: true }); return; }
  const job = todo[0];
  // Envoi (reprend la ou il s'etait arrete si besoin : plafond Gmail / temps)
  const sending = (st.sending && st.sending.id === job.s.id && st.sending.kind === job.kind) ? st.sending : { id: job.s.id, kind: job.kind, sent: [] };
  const done = new Set(sending.sent || []);
  const us = await db.collection("users").where("newsletter", "==", true).get();
  const transporter = gmailTransport();
  let n = 0, left = 0;
  const seenEmails = new Set();
  for (const u of us.docs) {
    const e = String(u.data().email || "").trim().toLowerCase();
    if (!e || e === AUTHOR_EMAIL || seenEmails.has(e)) continue;
    seenEmails.add(e);
    if (done.has(u.id)) continue;
    if (n >= NEWS_PER_RUN || !(await takeDaily("_global", MAX_GLOBAL_PER_DAY))) { left++; continue; }
    try { await sendNews(transporter, job.s, job.kind, e, u.id); n++; } catch (err) { logger.warn("news to", u.id, err.message); }
    done.add(u.id);
    sending.sent = Array.from(done);
    if (n % 10 === 0) await stRef.set({ sending }, { merge: true });
  }
  if (left > 0) {
    await stRef.set({ sending, known }, { merge: true });
    logger.info("newsletter partielle", { id: job.s.id, sent: n, left });
    return;
  }
  known[job.s.id] = job.kind;
  await stRef.set({ known, sending: admin.firestore.FieldValue.delete(), last: { id: job.s.id, kind: job.kind, count: done.size, at: new Date().toISOString() } }, { merge: true });
  try {
    await transporter.sendMail({ from: { name: FROM_NAME, address: FROM_ADDR }, to: AUTHOR_INBOX,
      subject: "Youlo182 : newsletter envoyee (" + ((job.s.fr && job.s.fr.title) || job.s.id) + ")",
      text: "Coucou Julie,\n\nLa newsletter \"" + (job.kind === "teaser" ? "nouvelle histoire bientot" : "nouvelle histoire en ligne") + "\" pour " +
        ((job.s.fr && job.s.fr.title) || job.s.id) + " est partie a " + done.size + " inscrit(e)s." });
  } catch (e) { logger.warn("recap news", e.message); }
});

// Apercu : envoie la newsletter d'une histoire UNIQUEMENT a youlo182.fanfics@gmail.com.
//   .../newsletterPreview?k=<HMAC("preview")>&id=<id histoire>&kind=teaser|live&when=<date ISO optionnelle>
exports.newsletterPreview = onRequest({ secrets: [GMAIL_APP_PASSWORD, UNSUB_KEY], invoker: "public" }, async (req, res) => {
  const want = crypto.createHmac("sha256", UNSUB_KEY.value()).update("preview").digest("hex");
  if ((req.query.k || "") !== want) { res.status(403).send("forbidden"); return; }
  const s = (await fetchStories()).find((x) => x.id === req.query.id);
  if (!s) { res.status(404).send("histoire inconnue"); return; }
  const story = Object.assign({}, s);
  if (req.query.when) story.releaseAt = String(req.query.when);
  await sendNews(gmailTransport(), story, req.query.kind === "live" ? "live" : "teaser", AUTHOR_INBOX, null);
  res.send("apercu envoye a " + AUTHOR_INBOX);
});

// ============================================================================
// RECAP DE LA SEMAINE (chaque lundi 9h, a youlo182.fanfics@gmail.com)
// ============================================================================
async function weeklyRecap() {
  const now = Date.now(), weekAgo = now - 7 * 24 * 3600 * 1000;
  const recRef = db.doc("mailState/_recap");
  const prev = (await recRef.get()).data() || null;
  const tot = (await db.doc("stats/totals").get()).data() || {};
  const users = (await db.collection("users").count().get()).data().count;
  const nl = (await db.collection("users").where("newsletter", "==", true).count().get()).data().count;
  const newUsers = (await db.collection("users").where("createdAt", ">=", admin.firestore.Timestamp.fromMillis(weekAgo)).count().get()).data().count;
  const stories = await fetchStories().catch(() => []);
  const byId = {}; stories.forEach((s) => { byId[s.id] = s; });
  const tname = (id) => (byId[id] && ((byId[id].fr && byId[id].fr.title) || (byId[id].en && byId[id].en.title))) || (id === "about" ? "Page À propos" : id);
  // Commentaires + reponses de la semaine (depuis les resumes stats/c_*)
  const idx = await db.collection("stats").get();
  let nC = 0, nR = 0; const perChap = {}; const latest = [];
  idx.forEach((d) => {
    if (!d.id.startsWith("c_")) return;
    const key = d.id.slice(2);
    (d.data().items || []).forEach((it) => {
      const isMe = (x) => x.admin === true || x.name === "Youlo182";
      if (tsMs(it.ts) >= weekAgo && !isMe(it)) { nC++; perChap[key] = (perChap[key] || 0) + 1; latest.push({ key, name: it.name, text: it.text, ts: tsMs(it.ts) }); }
      (it.replies || []).forEach((r) => { if (tsMs(r.ts) >= weekAgo && !isMe(r)) { nR++; perChap[key] = (perChap[key] || 0) + 1; } });
    });
  });
  const where = (key) => {
    const m = key.match(/^(.*)_(fr|en)_(\d+)$/);
    return m ? tname(m[1]) + " (" + m[2].toUpperCase() + ", ch. " + (Number(m[3]) + 1) + ")" : tname(key);
  };
  const top = Object.keys(perChap).sort((a, b) => perChap[b] - perChap[a]).slice(0, 3);
  latest.sort((a, b) => b.ts - a.ts);
  const diff = (k) => (prev && typeof prev[k] === "number") ? Math.max(0, (tot[k] || 0) - prev[k]) : null;
  const dV = diff("views"), dL = diff("likes");
  // Vues par histoire cette semaine
  let topStories = [];
  if (prev && prev.byStory) {
    topStories = Object.keys(tot.byStory || {}).map((id) => ({ id, v: ((tot.byStory[id] || {}).views || 0) - ((prev.byStory[id] || {}).views || 0) }))
      .filter((x) => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 3);
  }
  const L = [];
  L.push("Coucou Julie 💛", "", "Voici ta semaine sur Youlo182 :", "");
  L.push("👁️ Vues : " + (dV === null ? (tot.views || 0) + " au total (comparaison dès la semaine prochaine)" : "+" + dV + " (" + (tot.views || 0) + " au total)"));
  L.push("❤️ J'aime : " + (dL === null ? (tot.likes || 0) + " au total" : "+" + dL + " (" + (tot.likes || 0) + " au total)"));
  L.push("💬 Commentaires : +" + nC + ", réponses des lectrices : +" + nR);
  L.push("🧑 Nouveaux inscrits : +" + newUsers + " (" + users + " au total, dont " + nl + " à la newsletter)");
  if (topStories.length) { L.push("", "📖 Histoires les plus lues cette semaine :"); topStories.forEach((x) => L.push("   - " + tname(x.id) + " : " + x.v + " vues")); }
  if (top.length) { L.push("", "🔥 Chapitres les plus commentés :"); top.forEach((k) => L.push("   - " + where(k) + " : " + perChap[k])); }
  if (latest.length) { L.push("", "💌 Derniers commentaires :"); latest.slice(0, 5).forEach((c) => L.push("   - " + (c.name || "Anonyme") + " sur " + where(c.key) + " : « " + oneLine(c.text, 140) + " »")); }
  L.push("", "Tableau de bord : " + SITE + "/admin.html", "", "Bonne semaine ! 🥰");
  const text = L.join("\n");
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px;white-space:pre-wrap;">' + esc(text) + "</div>";
  await gmailTransport().sendMail({ from: { name: FROM_NAME, address: FROM_ADDR }, to: AUTHOR_INBOX,
    subject: "Youlo182 : ta semaine (" + (dV === null ? "" : "+" + dV + " vues, ") + "+" + nC + " commentaires, +" + newUsers + " inscrits)", text, html });
  await recRef.set({ views: tot.views || 0, likes: tot.likes || 0, comments: tot.comments || 0, users, byStory: tot.byStory || {}, at: new Date().toISOString() });
}
exports.weeklyRecap = onSchedule({ schedule: "every monday 09:00", timeZone: "Europe/Paris", secrets: [GMAIL_APP_PASSWORD] }, async () => { await weeklyRecap(); });
