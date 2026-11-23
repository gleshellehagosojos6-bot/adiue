// Unit tests for the Cloud Functions with an in-memory Firestore and the stub AI.
// Run from the functions folder:  node --test test/
process.env.AI_FAKE = '1';
process.env.AI_DAILY_LIMIT = '5';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

/* ---- in-memory Firestore for firebase-admin ---- */
const store = new Map();
const snap = (path) => ({ id: path.split('/').pop(), exists: store.has(path), data: () => (store.has(path) ? JSON.parse(JSON.stringify(store.get(path))) : undefined) });
const docRef = (path) => ({ path, get: async () => snap(path), set: async (d) => { store.set(path, d); } });
const fakeDb = {
  doc: docRef,
  collection: (p) => ({ get: async () => ({ docs: [...store.keys()].filter((k) => k.startsWith(p + '/') && k.split('/').length === p.split('/').length + 1).map(snap) }) }),
  runTransaction: async (fn) => fn({ get: async (r) => snap(r.path), set: (r, d) => store.set(r.path, d) }),
};
class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const mocks = {
  'firebase-admin': { initializeApp() {}, firestore: Object.assign(() => fakeDb, { FieldValue: { serverTimestamp: () => 'ts' } }) },
  'firebase-functions/v2/https': { onCall: (opts, handler) => handler, HttpsError },
  'firebase-functions/params': { defineSecret: () => ({ value: () => '' }) },
  'firebase-functions/v2': { setGlobalOptions() {} },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return mocks[req] || origLoad.call(this, req, ...rest); };
const fns = require('../index.js');

const T = '2026-11-22';
const uidA = 'userA'; const uidB = 'userB';
store.set(`users/${uidA}`, { username: 'Paul', name: 'Paul Santos' });
const put = (uid, id, e) => store.set(`users/${uid}/entries/${id}`, { type: 'entry', title: 't', body: 'b', visibility: 'private', date: T, tags: [], people: [], photos: [], ...e });
put(uidA, 'fam1', { title: 'Lake day', body: 'Swam with Mama', visibility: 'family', tags: ['family'] });
put(uidA, 'cap1', { title: 'Letter', body: 'Secret future', sealUntil: '2027-01-01' });
put(uidB, 'b1', { title: 'B only', body: 'not yours' });

const call = (name, uid, data) => fns[name]({ auth: uid ? { uid } : null, data });

test('chat requires login and a valid message', async () => {
  await assert.rejects(call('adlieuChat', null, { message: 'hi' }), (e) => e.code === 'unauthenticated');
  await assert.rejects(call('adlieuChat', uidA, { message: '' }), (e) => e.code === 'invalid-argument');
  await assert.rejects(call('adlieuChat', uidA, { message: 'x'.repeat(601) }), (e) => e.code === 'invalid-argument');
});

test('chat uses tools, cites only real ids, never sees sealed or other users\' entries', async () => {
  const r = await call('adlieuChat', uidA, { message: 'Summarize my week', today: T, history: [{ role: 'assistant', content: 'hello' }, { role: 'user', content: 'a' }, { role: 'user', content: 'b' }, { role: 'evil', content: 'x' }] });
  assert.equal(r.usedTools, true);
  assert.match(r.text, /\[\[fam1\]\]/);
  assert.doesNotMatch(r.text, /invented-id/, 'invented citations are removed');
  assert.doesNotMatch(r.text, /cap1|b1/);
});

test('allow filter: nothing permitted -> no citations', async () => {
  const r = await call('adlieuChat', uidA, { message: 'hi', today: T, allow: ['beneficiary'] });
  assert.doesNotMatch(r.text, /\[\[/);
});

test('summarize: own entry ok, sealed and missing rejected, other user not reachable', async () => {
  const r = await call('adlieuSummarize', uidA, { entryId: 'fam1', today: T });
  assert.ok(r.summary.length > 5);
  await assert.rejects(call('adlieuSummarize', uidA, { entryId: 'cap1', today: T }), (e) => e.code === 'failed-precondition');
  await assert.rejects(call('adlieuSummarize', uidA, { entryId: 'b1', today: T }), (e) => e.code === 'not-found');
  await assert.rejects(call('adlieuSummarize', uidA, { entryId: '../x', today: T }), (e) => e.code === 'invalid-argument');
});

test('daily limit per user', async () => {
  // userA used 3 so far today (2 chats + 1 summary); the limit is 5
  await call('adlieuChat', uidA, { message: 'four', today: T });
  await call('adlieuChat', uidA, { message: 'five', today: T });
  await assert.rejects(call('adlieuChat', uidA, { message: 'over', today: T }), (e) => e.code === 'resource-exhausted');
  const next = await call('adlieuChat', uidA, { message: 'new day', today: '2026-11-23' });
  assert.ok(next.text);
});

test('without the API key and stub, AI reports not set up', async () => {
  delete require.cache[require.resolve('../index.js')];
  process.env.AI_FAKE = '';
  const real = require('../index.js');
  await assert.rejects(real.adlieuChat({ auth: { uid: uidB }, data: { message: 'hi', today: T } }), (e) => e.code === 'failed-precondition');
});
