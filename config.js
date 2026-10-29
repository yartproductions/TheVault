/* ─────────────────────────────────────────────────────────────
   Obsidian Vault — configuration
   Leave `firebase: null` to run in LOCAL MODE (saved in this browser only).
   To sync live across every device, paste your Firebase web-app config
   below (Firebase console → Project settings → Your apps → Web app → Config).
   These values are public identifiers, not secrets — access is protected
   by Firebase Authentication + the rules in firestore.rules / storage.rules.
   ───────────────────────────────────────────────────────────── */
window.VAULT_CONFIG = {
  // Where listing photos are stored when Firebase is on:
  //   'firestore' — works on the free Spark plan (photos compressed to ~1600px)
  //   'storage'   — full-size files in Cloud Storage (requires the Blaze plan)
  photos: 'firestore',

  firebase: {
    apiKey: "AIzaSyAAyGyClAYviFr0LgzdXBqna1LpPH57G-M",
    authDomain: "obsidian-vault-38dfd.firebaseapp.com",
    projectId: "obsidian-vault-38dfd",
    storageBucket: "obsidian-vault-38dfd.firebasestorage.app",
    messagingSenderId: "1096414434158",
    appId: "1:1096414434158:web:3d87a66e0fc893d5f3a77f",
    measurementId: "G-7PKW4DLN9T"
  }
};
