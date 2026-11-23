# ADLIEU — A Personal AI Diary · Firebase edition

Kumpletong ADLIEU web app na tumatakbo sa **Firebase**:

| Bahagi | Firebase service | Laman |
|---|---|---|
| Web app (Today, Journal, Constellation, Adlieu AI, Profile, About) | **Firebase Hosting** | `public/` |
| Register / Log in / Log out / palit ng password / delete account | **Firebase Authentication** (Email/Password) | `public/adlieu-firebase.js` |
| Diary entries, quick notes, mood check-ins, photos, profile, chat history | **Cloud Firestore** | `firestore.rules` |
| Adlieu AI (chat + summarize) na may Perspective Lock | **Cloud Functions** (Node 20) | `functions/index.js` |

Puwede pa ring kahit anong pangalan ang username (hal. "Gleshelle Mae"). Ginagawa itong pribadong login ID sa likod, kaya hindi na kailangan ng email.

---

## 1. Ano ang kailangan

- **Node.js 20+** → <https://nodejs.org>
- **Firebase CLI** → `npm install -g firebase-tools`
- Isang **Google account**

## 2. Gumawa ng Firebase project

1. Pumunta sa <https://console.firebase.google.com> → **Add project** (hal. `adlieu-diary`).
2. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable → Save.**
3. **Build → Firestore Database → Create database →** piliin ang location (hal. `asia-southeast1`, Singapore) → **Start in production mode.**
4. **Project settings (⚙️) → General → Your apps → Web (`</>`)** → mag-register ng app → kopyahin ang `firebaseConfig`.

## 3. Ilagay ang config

1. Buksan ang **`public/firebase-config.js`** at palitan ang laman ng `ADLIEU_FIREBASE_CONFIG` ng kinopya mong config.
2. Buksan ang **`.firebaserc`** at palitan ang `your-project-id` ng Project ID mo.

## 4. I-deploy ang app at ang security rules (libre — Spark plan)

```bash
firebase login
firebase deploy --only hosting,firestore
```

Buksan ang link na ibibigay (hal. `https://adlieu-diary.web.app`). Gumagana na ang Register, Login, diary, photos, Constellation, at Profile.
Gumagana rin ito sa phone: buksan ang link at piliin ang **Add to Home Screen** para magmukhang app.

## 5. I-on ang Adlieu AI (opsyonal — kailangan ng Blaze plan)

Kailangan ng **Blaze (pay-as-you-go) plan** ang Cloud Functions, at ng **Anthropic API key** ang AI (<https://console.anthropic.com>). May bayad ang dalawa ayon sa paggamit.

```bash
# sa Firebase console: Upgrade → Blaze
cd functions && npm install && cd ..
firebase functions:secrets:set ANTHROPIC_API_KEY     # i-paste ang key kapag tinanong
firebase deploy --only functions
```

- Ang functions ay naka-deploy sa `asia-southeast1`, kapareho ng `ADLIEU_FUNCTIONS_REGION` sa `firebase-config.js`.
- Hanggang **100 AI request bawat user bawat araw** (palitan sa `AI_DAILY_LIMIT` kung gusto).
- Kung hindi pa naka-set up ang AI, sasabihin ng Adlieu AI na hindi pa ito naka-set up, at gagana pa rin ang lahat ng iba.

---

## Paano gumagana ang privacy at seguridad

- **Login**: Firebase Authentication. Hindi kailanman naka-save ang password sa database.
- **Firestore rules** (`firestore.rules`): bawat diary ay nasa `/users/{uid}`, at **ang may-ari lang na naka-login** ang makakabasa o makakasulat dito. Sarado ang lahat ng iba. May limit din sa laki at uri ng data (haba ng kuwento, bilang ng tags, 6 na photo, at iba pa).
- **Time capsule**: hindi ipinapakita ang laman, mood, at photo hangga't hindi pa dumarating ang petsa. Hindi rin ito naaabot ng Adlieu AI.
- **Perspective Lock (Adlieu AI)**: sa **Cloud Function** lang nakatago ang AI key, hindi sa browser. Hindi kailanman natatanggap ng AI ang buong diary. Mga search tool na tumatakbo sa server ang ginagamit nito, sa mga entry lang na pinayagan ng user at hindi naka-seal, at tinatanggal ng server ang anumang citation na inimbento ng AI.
- **Photos**: pinaliliit at naka-save sa Firestore, kaya sapat ang libreng Spark plan at hindi na kailangan ng Cloud Storage.
- **Delete account**: hihingin muna ang password, tapos buburahin ang lahat ng entries, photos, chat, profile, at ang login mismo.

## Data structure (Firestore)

```
users/{uid}                     ← profile: username, name, beneficiary, legacyLetter, avatar, accent, …
users/{uid}/entries/{entryId}   ← type, title, body, mood, tags[], people[], location, visibility, date, sealUntil, fav, photos[]
users/{uid}/photos/{photoId}    ← data (compressed image)
users/{uid}/meta/chat           ← Adlieu AI conversation
users/{uid}/usage/ai            ← AI daily counter (written only by Cloud Functions)
```

## Folder structure

```
adlieu-firebase/
├─ firebase.json            # Hosting, Firestore, Functions, Emulators
├─ .firebaserc              # ← ilagay ang Project ID
├─ firestore.rules          # security rules (owner-only)
├─ firestore.indexes.json
├─ public/                  # ← ito ang naka-host na web app
│  ├─ index.html            # ADLIEU app
│  ├─ firebase-config.js    # ← ilagay ang Firebase config
│  ├─ adlieu-firebase.js    # Auth + Firestore + Functions + voice adapter
│  ├─ vendor/firebase-bundle.js   # Firebase JS SDK 13.4 (naka-bundle, walang CDN)
│  └─ icon.png              # logo ng ADLIEU
├─ functions/
│  ├─ index.js              # adlieuChat, adlieuSummarize
│  ├─ package.json
│  └─ test/functions.test.js
└─ build/                   # para gumawa ulit ng index.html mula sa claude.ai edition
```

## Local testing (Firebase Emulator Suite)

```bash
cd functions && npm install && cd ..
echo "AI_FAKE=1" > functions/.env.local      # pekeng AI para sa testing, hindi kailangan ng key
firebase emulators:start
```

Buksan ang <http://localhost:5000>. Kapag `localhost` ang address, kusang kumokonekta ang app sa mga emulator (Auth 9099, Firestore 8080, Functions 5001).

Unit tests ng Cloud Functions:

```bash
cd functions && node --test test/*.test.js
```

## Voice

Sa Firebase edition, ang **sariling speech feature ng browser** ang gamit sa 🎙️ Speak at 🔊 Listen (Web Speech API). Pinakamahusay ito sa Chrome at Edge. Kapag hindi suportado ng browser, kusang nawawala ang mga button.

## Mga tala

- Kapag hindi pa napapalitan ang config, gumagana pa rin ang app pero sa browser lang naka-save ang data, at may paalala sa itaas.
- Ang `build/make-index.py` ay gumagawa ng `public/index.html` mula sa claude.ai edition ng ADLIEU, kaya madaling i-update ang dalawa nang sabay.

BSCS 4-2 · Ingrid Bermeo (QA) · Jackielyn Cesista (UI/UX) · Erich Gerero (Backend) · Merssa Gutlay (Documentator) · Gleshelle Mae Hagosojos (Frontend)
