// Configuration Firebase partagée par index.html, admin.html et write.html.
// (Ces valeurs ne sont pas secrètes : la sécurité vient des règles Firestore.)
export const firebaseConfig = {
  apiKey: "AIzaSyDCXtXM-F_AoqwlUTk_trk3Ny9dxy-7q-g",
  authDomain: "youlo182-fanfics.firebaseapp.com",
  projectId: "youlo182-fanfics",
  storageBucket: "youlo182-fanfics.firebasestorage.app",
  messagingSenderId: "254835522518",
  appId: "1:254835522518:web:c309ed0c14ff24a19c0277"
};

// Compte autrice (Youlo182) : seul ce compte a accès à l'admin et à l'éditeur.
export const AUTHOR_EMAIL = "julie.cacciola@gmail.com";
// Pseudo réservé à l'autrice (personne d'autre ne peut le prendre).
export const AUTHOR_NAME = "Youlo182";

// Version du SDK Firebase utilisée partout (une seule ligne à changer pour mettre à jour).
export const FB_VERSION = "10.12.2";
export const FB_CDN = "https://www.gstatic.com/firebasejs/" + FB_VERSION + "/";

// App Check (anti-robots) : laisser VIDE tant que la clé reCAPTCHA Enterprise n'est pas créée.
// Voir youlo182-notes/README pour la marche à suivre. Vide = App Check désactivé.
export const APPCHECK_SITE_KEY = "";

// Active App Check si une clé est renseignée. Ne bloque jamais le site en cas d'échec.
export async function maybeInitAppCheck(app){
  if(!APPCHECK_SITE_KEY) return;
  try{
    const m = await import(FB_CDN + "firebase-app-check.js");
    m.initializeAppCheck(app, {
      provider: new m.ReCaptchaEnterpriseProvider(APPCHECK_SITE_KEY),
      isTokenAutoRefreshEnabled: true
    });
  }catch(e){ console.warn("App Check indisponible", e); }
}

// Transforme un pseudo en clé unique : minuscules, sans accents, espaces simplifiés.
// "Youlò 182" et "youlo 182" donnent la même clé -> impossible d'avoir deux fois le même pseudo.
export function pseudoKey(name){
  return String(name||"")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/\s+/g, "").replace(/[\/.#$\[\]]/g, "_")
    .trim().slice(0, 60);
}
