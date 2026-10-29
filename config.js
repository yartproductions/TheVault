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

  firebase: null
  /* Example:
  firebase: {
    apiKey: "AIza...",
    authDomain: "obsidian-vault-xxxx.firebaseapp.com",
    projectId: "obsidian-vault-xxxx",
    storageBucket: "obsidian-vault-xxxx.appspot.com",
    messagingSenderId: "123456789",
    appId: "1:123456789:web:abc123"
  }
  */
};
