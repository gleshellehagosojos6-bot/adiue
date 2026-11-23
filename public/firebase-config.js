/* ============================================================
   PASTE YOUR FIREBASE WEB APP CONFIG HERE
   Firebase console → Project settings → General → Your apps → Web app → "SDK setup and configuration" → Config
   ============================================================ */
window.ADLIEU_FIREBASE_CONFIG = {
  apiKey: "PASTE_API_KEY",
  authDomain: "your-project-id.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project-id.firebasestorage.app",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:0000000000000000000000"
};

/* Region where you deploy the Cloud Functions (Adlieu AI). Asia: "asia-southeast1" (Singapore). */
window.ADLIEU_FUNCTIONS_REGION = "asia-southeast1";

/* Local testing with the Firebase Emulator Suite: set to true while running "firebase emulators:start". */
window.ADLIEU_USE_EMULATORS = location.hostname === "localhost" || location.hostname === "127.0.0.1";
