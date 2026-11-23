/* ADIEU ⇄ Firebase adapter
 * - Firebase Authentication (username + password; the username is mapped to a private login id)
 * - Cloud Firestore, exposed with the small doc/collection API the app uses
 * - Cloud Functions for Adieu AI (the AI key never reaches the browser)
 * - Browser speech (Web Speech API) for voice writing and read-aloud
 */
(function () {
  const F = window.FirebaseSDK;
  const cfg = window.ADIEU_FIREBASE_CONFIG || {};
  const configured = cfg.apiKey && !/PASTE/.test(cfg.apiKey);
  const FB = (window.ADIEU_FB = { configured, ready: false });
  if (!F || !configured) { console.warn('[ADIEU] Firebase is not configured — edit public/firebase-config.js'); return; }

  const app = F.initializeApp(cfg);
  const auth = F.getAuth(app);
  const fs = F.initializeFirestore(app, { ignoreUndefinedProperties: true });
  const fns = F.getFunctions(app, window.ADIEU_FUNCTIONS_REGION || 'asia-southeast1');
  if (window.ADIEU_USE_EMULATORS) {
    const host = location.hostname;
    F.connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
    F.connectFirestoreEmulator(fs, host, 8080);
    F.connectFunctionsEmulator(fns, host, 5001);
  }
  FB.ready = true;

  /* ---------- errors → the app's error codes ---------- */
  const CODE = { 'permission-denied': 'invalid_argument', 'invalid-argument': 'invalid_argument', 'resource-exhausted': 'quota_exceeded',
    'unavailable': 'unavailable', 'deadline-exceeded': 'unavailable', 'unauthenticated': 'revoked', 'failed-precondition': 'invalid_argument' };
  const wrapErr = (e) => { const c = String((e && e.code) || '').replace(/^(firestore|functions)\//, ''); const err = new Error((e && e.message) || 'Firebase error'); err.code = CODE[c] || 'unavailable'; err.fbCode = e && e.code; return err; };
  const guard = (p) => p.catch((e) => { throw wrapErr(e); });

  /* ---------- Firestore adapter (same shape the app already uses) ---------- */
  const snapDoc = (s) => ({ id: s.id, exists: s.exists(), data: () => s.data(), metadata: { fromCache: s.metadata.fromCache, hasPendingWrites: s.metadata.hasPendingWrites } });
  function docRef(path) {
    const ref = F.doc(fs, path);
    return {
      id: ref.id, path,
      get: () => guard(F.getDoc(ref)).then(snapDoc),
      set: (data) => guard(F.setDoc(ref, data)),
      delete: () => guard(F.deleteDoc(ref)),
      onSnapshot: (next, err) => F.onSnapshot(ref, (s) => next(snapDoc(s)), (e) => err && err(wrapErr(e))),
      collection: (name) => colRef(path + '/' + name),
    };
  }
  function colRef(path) {
    const ref = F.collection(fs, path);
    const wrapQ = (qs) => ({ docs: qs.docs.map(snapDoc), size: qs.size, empty: qs.empty, metadata: { fromCache: qs.metadata.fromCache, hasPendingWrites: qs.metadata.hasPendingWrites } });
    return {
      path,
      doc: (id) => docRef(path + '/' + id),
      get: () => guard(F.getDocs(ref)).then(wrapQ),
      onSnapshot: (next, err) => F.onSnapshot(ref, (qs) => next(wrapQ(qs)), (e) => err && err(wrapErr(e))),
    };
  }
  FB.db = { doc: docRef, collection: colRef };

  /* ---------- Authentication ---------- */
  const norm = (u) => String(u || '').trim().replace(/\s+/g, ' ').toLowerCase();
  async function loginEmail(username) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('adieu-user:' + norm(username)));
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('').slice(0, 32) + '@users.adieu.app';
  }
  function authError(e) {
    const c = (e && e.code) || '';
    const msg = c === 'auth/email-already-in-use' ? 'That username is already taken.'
      : ['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email', 'auth/invalid-login-credentials'].includes(c) ? 'Incorrect username or password.'
      : c === 'auth/weak-password' ? 'Password must be at least 6 characters.'
      : c === 'auth/too-many-requests' ? 'Too many attempts. Please wait a few minutes and try again.'
      : c === 'auth/network-request-failed' ? 'No connection. Check your internet and try again.'
      : c === 'auth/requires-recent-login' ? 'For your safety, please log out and log in again first.'
      : 'Something went wrong. Please try again.';
    const err = new Error(msg); err.code = c; return err;
  }
  FB.uid = () => (auth.currentUser ? auth.currentUser.uid : null);
  FB.onFirstAuthState = () => new Promise((res) => { const off = F.onAuthStateChanged(auth, (u) => { off(); res(u ? u.uid : null); }); });
  FB.register = async (username, password) => {
    try { await F.setPersistence(auth, F.browserLocalPersistence); const c = await F.createUserWithEmailAndPassword(auth, await loginEmail(username), password); return c.user.uid; }
    catch (e) { throw authError(e); }
  };
  FB.login = async (username, password, remember) => {
    try { await F.setPersistence(auth, remember ? F.browserLocalPersistence : F.browserSessionPersistence); const c = await F.signInWithEmailAndPassword(auth, await loginEmail(username), password); return c.user.uid; }
    catch (e) { throw authError(e); }
  };
  FB.logout = () => F.signOut(auth).catch(() => {});
  FB.reauth = async (password) => {
    const u = auth.currentUser; if (!u) throw authError({ code: 'auth/requires-recent-login' });
    try { await F.reauthenticateWithCredential(u, F.EmailAuthProvider.credential(u.email, password)); }
    catch (e) { throw authError(e); }
  };
  FB.changePassword = async (current, next) => { await FB.reauth(current); try { await F.updatePassword(auth.currentUser, next); } catch (e) { throw authError(e); } };
  FB.deleteLogin = async () => { try { await F.deleteUser(auth.currentUser); } catch (e) { throw authError(e); } };

  /* ---------- Adieu AI (Cloud Functions) ---------- */
  const callable = (name) => F.httpsCallable(fns, name, { timeout: 70000 });
  function aiError(e) {
    const c = String((e && e.code) || '').replace('functions/', '');
    const err = new Error(e && e.message); err.code = c === 'resource-exhausted' ? 'rate_limited' : c === 'unauthenticated' ? 'not_granted' : c === 'failed-precondition' ? 'ai_unavailable' : 'unavailable';
    return err;
  }
  FB.chat = (payload) => callable('adieuChat')(payload).then((r) => r.data).catch((e) => { throw aiError(e); });
  FB.summarize = (payload) => callable('adieuSummarize')(payload).then((r) => r.data).catch((e) => { throw aiError(e); });

  /* ---------- Voice: browser speech recognition + speech synthesis ---------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  FB.dictation = !SR ? null : (function () {
    let rec = null; let active = false; const L = { final: new Set(), partial: new Set(), state: new Set() };
    const emit = (k, v) => L[k].forEach((f) => { try { f(v); } catch (e) { /* ignore */ } });
    return {
      start() {
        if (active) return Promise.resolve();
        rec = new SR(); rec.lang = navigator.language || 'en-US'; rec.interimResults = true; rec.continuous = true;
        return new Promise((resolve, reject) => {
          let started = false;
          rec.onstart = () => { started = true; active = true; emit('state', { state: 'listening' }); resolve(); };
          rec.onresult = (ev) => { let interim = ''; for (let i = ev.resultIndex; i < ev.results.length; i++) { const r = ev.results[i]; if (r.isFinal) emit('final', { text: ' ' + r[0].transcript.trim() }); else interim += r[0].transcript; } emit('partial', { text: interim }); };
          rec.onerror = (ev) => { const reason = ev.error === 'not-allowed' || ev.error === 'service-not-allowed' ? 'not_granted' : ev.error === 'aborted' ? 'stopped' : 'upstream_error'; if (!started) reject({ code: reason }); emit('state', { state: 'idle', reason }); active = false; };
          rec.onend = () => { if (active) emit('state', { state: 'idle', reason: 'stopped' }); active = false; emit('partial', { text: '' }); };
          emit('state', { state: 'starting' });
          try { rec.start(); } catch (e) { reject({ code: 'upstream_error' }); }
        });
      },
      stop() { if (rec) rec.stop(); return Promise.resolve(); },
      active: () => active,
      onFinal: (f) => (L.final.add(f), () => L.final.delete(f)),
      onPartial: (f) => (L.partial.add(f), () => L.partial.delete(f)),
      onState: (f) => (L.state.add(f), () => L.state.delete(f)),
    };
  })();
  FB.tts = !('speechSynthesis' in window) ? null : (function () {
    const L = new Set(); const emit = (v) => L.forEach((f) => { try { f(v); } catch (e) { /* ignore */ } });
    return {
      speak(text) {
        return new Promise((resolve, reject) => {
          speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(String(text).slice(0, 2000));
          u.onstart = () => emit({ state: 'speaking' });
          u.onend = () => { emit({ state: 'idle', reason: 'completed' }); resolve(); };
          u.onerror = (e) => { emit({ state: 'idle', reason: 'stopped' }); reject({ code: e.error || 'stopped' }); };
          speechSynthesis.speak(u);
        });
      },
      stop() { speechSynthesis.cancel(); emit({ state: 'idle', reason: 'stopped' }); },
      onState: (f) => (L.add(f), () => L.delete(f)),
    };
  })();

  /* ---------- the runtime the app asks for with claude.use(name) ---------- */
  const caps = {
    db: FB.db,
    user: { id: async () => FB.uid(), isOwner: () => true, canEdit: () => true, can: () => true },
    sample: Object.assign(async () => { throw Object.assign(new Error('use ADIEU_FB.chat'), { code: 'unavailable' }); }, { firebase: true }),
    dictation: FB.dictation,
    tts: FB.tts,
  };
  window.claude = { use: async (name) => caps[name] || null };
})();
