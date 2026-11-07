const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const path = require("path");

// This app's OTP login does NOT use Firebase — it only backs the optional
// /api/auth/google-login route. Previously, a missing service-account file
// made this `require()` throw at server startup, which crashed the ENTIRE
// backend (so *every* login — learner or doctor — silently failed, since
// there was no server to answer the request). Now a missing/invalid
// credential is caught here and just disables that one Google-login route
// instead of taking the whole app down.
let db = null;
let firebaseReady = false;

try {
  let serviceAccount;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    // Local dev fallback only — this file is gitignored and must never be
    // deployed. In production, set FIREBASE_SERVICE_ACCOUNT instead.
    serviceAccount = require(path.join(__dirname, "articulation-app-ff6e7-firebase-adminsdk-fbsvc-a1caa99180.json"));
  }
  const app = initializeApp({ credential: cert(serviceAccount) });
  db = getFirestore(app);
  firebaseReady = true;
} catch (err) {
  console.warn("Firebase Admin not configured — /api/auth/google-login is disabled. (Gmail OTP login is unaffected.)");
  console.warn("Reason:", err.message);
}

module.exports = { db, firebaseReady };
