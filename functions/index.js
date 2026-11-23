/* ADIEU — Cloud Functions
 *
 * adieuChat       Adieu AI chat with tool use over the owner's diary.
 * adieuSummarize  Summary of one entry.
 *
 * Perspective Lock: the model never receives the diary. It can only call the search tools below,
 * which run here (with the Admin SDK) over the signed-in owner's *permitted, unsealed* entries.
 * The Anthropic key is a Secret Manager secret and never reaches the browser.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

setGlobalOptions({ region: process.env.FUNCTIONS_REGION || 'asia-southeast1', maxInstances: 10 });

const MODEL = process.env.AI_MODEL || 'claude-haiku-5-5';
const FAKE = process.env.AI_FAKE === '1'; // emulator testing only: a stub that still exercises the tools
const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT || 100); // AI requests per user per day
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/* ---------- helpers ---------- */
function requireUser(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Please log in to use Adieu AI.');
  return req.auth.uid;
}
const todayOf = (v) => (typeof v === 'string' && ISO.test(v) ? v : new Date().toISOString().slice(0, 10));
const isSealed = (e, today) => !!(e.sealUntil && e.sealUntil > today);

async function countUsage(uid, today) {
  const ref = db.doc(`users/${uid}/usage/ai`);
  await db.runTransaction(async (t) => {
    const s = await t.get(ref);
    const d = s.exists ? s.data() : {};
    const n = d.day === today ? (d.count || 0) : 0;
    if (n >= DAILY_LIMIT) throw new HttpsError('resource-exhausted', 'You reached today\'s Adieu AI limit. Please try again tomorrow. 🌙');
    t.set(ref, { day: today, count: n + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  });
}

async function loadEntries(uid) {
  const snap = await db.collection(`users/${uid}/entries`).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function getClient() {
  if (FAKE) return fakeClient;
  const key = ANTHROPIC_API_KEY.value();
  if (!key) throw new HttpsError('failed-precondition', 'Adieu AI is not set up: add the ANTHROPIC_API_KEY secret.');
  const sdk = require('@anthropic-ai/sdk');
  const Anthropic = sdk.default || sdk.Anthropic || sdk;
  return new Anthropic({ apiKey: key });
}

function aiFailure(err) {
  if (err instanceof HttpsError) return err;
  if (err && (err.status === 429 || err.status === 529)) return new HttpsError('resource-exhausted', 'Adieu AI is busy — please try again in a minute.');
  if (err && err.status === 401) return new HttpsError('failed-precondition', 'The ANTHROPIC_API_KEY secret is invalid.');
  console.error('Adieu AI error', err);
  return new HttpsError('internal', 'Adieu AI had a problem. Please try again.');
}

/* ---------- tools (run on the server) ---------- */
const TOOLS = [
  {
    name: 'search_entries',
    description: "Search the owner's permitted diary entries. All filters optional. Returns up to 15 matches with short excerpts.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'words to look for' },
        tag: { type: 'string' }, person: { type: 'string' }, location: { type: 'string' },
        from_date: { type: 'string', description: 'YYYY-MM-DD' }, to_date: { type: 'string', description: 'YYYY-MM-DD' },
        type: { type: 'string', enum: ['entry', 'note'] },
      },
    },
  },
  { name: 'get_entry', description: 'Read the full text of one permitted entry by id.', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'diary_overview', description: 'Counts of permitted entries, date range, and the most used tags, places and people.', input_schema: { type: 'object', properties: {} } },
];

const brief = (e) => ({
  id: e.id, date: e.date, type: e.checkin ? 'mood check-in' : e.type, title: e.type === 'entry' ? e.title : undefined,
  mood: e.mood || undefined, tags: e.tags || [], location: e.location || undefined, people: e.people || [], excerpt: String(e.body || '').slice(0, 220),
});

function toolRunner(entries, seen) {
  const lc = (s) => String(s || '').toLowerCase();
  return {
    search_entries(i = {}) {
      const words = lc(i.query).split(/\s+/).filter((w) => w.length > 2);
      let r = entries.filter((e) =>
        (!i.tag || (e.tags || []).includes(lc(i.tag).replace('#', ''))) &&
        (!i.person || (e.people || []).some((p) => lc(p).includes(lc(i.person)))) &&
        (!i.location || lc(e.location).includes(lc(i.location))) &&
        (!i.from_date || e.date >= i.from_date) && (!i.to_date || e.date <= i.to_date) &&
        (!i.type || e.type === i.type));
      if (words.length) {
        r = r.map((e) => [e, words.filter((w) => lc([e.title, e.body, e.location, ...(e.tags || []), ...(e.people || [])].join(' ')).includes(w)).length])
          .filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).map((x) => x[0]);
      } else {
        r.sort((a, b) => String(b.date).localeCompare(String(a.date)));
      }
      const out = r.slice(0, 15).map(brief);
      out.forEach((o) => seen.add(o.id));
      return { count: r.length, results: out };
    },
    get_entry(i = {}) {
      const e = entries.find((x) => x.id === i.id);
      if (!e) return { error: 'No permitted entry with that id' };
      seen.add(e.id);
      return { ...brief(e), body: String(e.body || '').slice(0, 4000) };
    },
    diary_overview() {
      const count = (k) => { const m = {}; entries.forEach((e) => [].concat(e[k] || []).filter(Boolean).forEach((v) => { m[v] = (m[v] || 0) + 1; })); return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 12); };
      const ds = entries.map((e) => e.date).sort();
      return { total: entries.length, entries: entries.filter((e) => e.type === 'entry').length, first: ds[0], last: ds[ds.length - 1], top_tags: count('tags'), top_places: count('location'), top_people: count('people') };
    },
  };
}

function systemPrompt(name, today) {
  return `You are Adieu AI, the warm, caring diary companion inside the ADIEU personal diary app, chatting with ${name}.
PERSONALITY: kind, encouraging, a good listener — like a supportive friend. Chat style: short messages (usually 1–4 sentences, max ~120 words), at most one fitting emoji. Reply in the SAME language the owner uses (English, Filipino/Tagalog, Taglish or Bisaya). Plain text only.
WHAT YOU CAN DO: listen and respond to feelings; give gentle general encouragement, ideas and practical tips; suggest diary prompts; help draft an entry when asked; and answer questions about their own memories using the diary tools.
PERSPECTIVE LOCK — follow strictly:
- You know NOTHING about the owner's life except what the diary tools return. Use the tools whenever the question touches their past, people, places, moods or entries.
- Never invent, guess or embellish personal facts. If the tools return nothing relevant, say you couldn't find it in their diary.
- Cite every personal claim from the diary with the entry id in double brackets right after it, like [[abc123]]. Only cite ids the tools returned.
- If the owner seems in serious distress or mentions self-harm, respond with care and encourage them to reach out to someone they trust or a local helpline.
Today's date is ${today}.`;
}

/* ---------- adieuChat ---------- */
exports.adieuChat = onCall({ secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 60, memory: '256MiB' }, async (req) => {
  const uid = requireUser(req);
  const d = req.data || {};
  const message = String(d.message || '').trim();
  if (!message || message.length > 600) throw new HttpsError('invalid-argument', 'Message must be 1–600 characters.');
  const allowed = ['private', 'family', 'beneficiary'];
  const allow = Array.isArray(d.allow) ? d.allow.filter((v) => allowed.includes(v)) : allowed;
  const today = todayOf(d.today);
  // history: alternating user/assistant turns, starting with user, at most 8, plain strings
  const hist = [];
  (Array.isArray(d.history) ? d.history : []).slice(-8).forEach((m) => {
    if (!m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim()) return;
    const c = m.content.slice(0, 4000);
    if (hist.length && hist[hist.length - 1].role === m.role) hist[hist.length - 1] = { role: m.role, content: c }; else hist.push({ role: m.role, content: c });
  });
  while (hist.length && hist[0].role !== 'user') hist.shift();
  if (hist.length && hist[hist.length - 1].role === 'user') hist.pop();

  await countUsage(uid, today);
  const profile = (await db.doc(`users/${uid}`).get()).data() || {};
  const permitted = (await loadEntries(uid)).filter((e) => allow.includes(e.visibility || 'private') && !isSealed(e, today));
  const seen = new Set();
  const run = toolRunner(permitted, seen);
  const messages = [...hist, { role: 'user', content: message }];
  let text = '';
  let usedTools = false;
  try {
    const client = getClient();
    for (let step = 0; step < 6; step++) {
      const resp = await client.messages.create({ model: MODEL, max_tokens: 700, system: systemPrompt(profile.name || 'the owner', today), tools: TOOLS, messages });
      const calls = resp.content.filter((c) => c.type === 'tool_use');
      if (resp.stop_reason !== 'tool_use' || !calls.length) { text = resp.content.filter((c) => c.type === 'text').map((c) => c.text).join(''); break; }
      usedTools = true;
      messages.push({ role: 'assistant', content: resp.content });
      messages.push({ role: 'user', content: calls.map((c) => {
        let out; try { out = run[c.name] ? run[c.name](c.input || {}) : { error: 'Unknown tool' }; } catch (e) { out = { error: String(e.message || e) }; }
        return { type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(out) };
      }) });
    }
  } catch (err) { throw aiFailure(err); }
  text = (text || "I couldn't find anything about that in your diary.")
    .replace(/\[\[([^\]]+)\]\]/g, (m, id) => (seen.has(id.trim()) ? m : '')) // drop invented citations
    .trim();
  return { text, usedTools };
});

/* ---------- adieuSummarize ---------- */
exports.adieuSummarize = onCall({ secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 60, memory: '256MiB' }, async (req) => {
  const uid = requireUser(req);
  const id = String((req.data && req.data.entryId) || '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new HttpsError('invalid-argument', 'Missing entry id.');
  const today = todayOf(req.data && req.data.today);
  const snap = await db.doc(`users/${uid}/entries/${id}`).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Entry not found.');
  const e = snap.data();
  if (isSealed(e, today)) throw new HttpsError('failed-precondition', 'This time capsule is still sealed.');
  if (!String(e.body || '').trim()) throw new HttpsError('invalid-argument', 'This entry has no text to summarize.');
  await countUsage(uid, today);
  try {
    const resp = await getClient().messages.create({
      model: MODEL, max_tokens: 400,
      messages: [{ role: 'user', content: `Summarize this diary entry for its owner in 2 sentences, then list 2–4 key takeaways as short lines starting with "• ". Use only what is written; add no new facts. Address the owner as "you". Plain text.\n\nEntry (${e.date}${e.title ? `, "${e.title}"` : ''}):\n${String(e.body).slice(0, 6000)}` }],
    });
    return { summary: resp.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim() };
  } catch (err) { throw aiFailure(err); }
});

/* ---------- emulator test stub ---------- */
const fakeClient = {
  messages: {
    async create(params) {
      const last = params.messages[params.messages.length - 1];
      const results = Array.isArray(last.content) ? last.content.filter((c) => c.type === 'tool_result') : [];
      if (params.tools && !results.length) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_fake', name: 'search_entries', input: {} }] };
      if (!params.tools) return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'You had a lovely day.\n• Family time matters to you.' }] };
      let ids = []; try { ids = JSON.parse(results[0].content).results.map((r) => r.id); } catch (e) { /* none */ }
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: ids.length ? `You wrote about a lovely moment [[${ids[0]}]] [[invented-id]].` : 'Here for you 🌙' }] };
    },
  },
};
