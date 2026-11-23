#!/usr/bin/env python3
"""Builds public/index.html (Firebase edition) from the claude.ai edition of ADLIEU.
Usage: python3 make-index.py <source adlieu.html> <output index.html>"""
import sys

src, out = sys.argv[1], sys.argv[2]
s = open(src, encoding='utf-8').read()


def rep(a, b, n=1):
    global s
    c = s.count(a)
    if c != n:
        raise SystemExit(f'expected {n} match(es), found {c}: {a[:90]!r}')
    s = s.replace(a, b)


# 1) load Firebase SDK + config + adapter before the app script
i = s.index('<script>\n')
s = s[:i] + '<script src="vendor/firebase-bundle.js"></script>\n<script src="firebase-config.js"></script>\n<script src="adlieu-firebase.js"></script>\n' + s[i:]

# 2) storage: Firestore at users/{uid}
rep("""    try { [db,user] = await Promise.all([window.claude?.use?.('db'), window.claude?.use?.('user')]); } catch {}
    let id=null; try { id = user ? await user.id() : null; } catch {}
    if (db && id) { this.db=db; this.uid=id; this.mode='cloud';
    } else {
      $('#storeBanner').textContent = 'Saving to this browser only — sign in to claude.ai to keep your diary safely across devices.';""",
    """    if (window.ADLIEU_FB && ADLIEU_FB.ready) { this.db=ADLIEU_FB.db; this.mode='cloud';
    } else {
      $('#storeBanner').textContent = 'Firebase is not set up yet — saving to this browser only. Paste your Firebase config in firebase-config.js (see README).';""")
rep("  acctRef(u){ return this.db.doc('data/users/'+this.uid+'/acct-'+u); },",
    "  acctRef(u){ return this.db.doc('users/'+u); }, /* u = Firebase Auth uid */")

# 3) boot: restore the Firebase session
rep("""async function boot(){
  await Store.init();
  $('#loading').classList.add('hidden');""", """async function boot(){
  await Store.init();
  if(Store.mode==='cloud'){
    const fuid=await ADLIEU_FB.onFirstAuthState();
    $('#loading').classList.add('hidden');
    if(fuid){ try{ const a=await Store.getAccount(fuid); if(a){ Store.use(fuid); profile=a; return enterApp(); } }catch{} await ADLIEU_FB.logout(); }
    return showAuth('login');
  }
  $('#loading').classList.add('hidden');""")

# 4) register with Firebase Auth
rep("""  btn.disabled=true; btn.textContent='Creating account…';
  try{
    const u=await userKey(display);""", """  btn.disabled=true; btn.textContent='Creating account…';
  if(Store.mode==='cloud'){
    try{
      const fuid=await ADLIEU_FB.register(display, f.password.value);
      const acct={ username:display, name:f.name.value.trim(), email:f.email.value.trim(), birthday:f.birthday.value||'', bio:'',
        beneficiary:{name:f.benName.value.trim(), relation:f.benRel.value.trim()}, createdAt:new Date().toISOString() };
      try{ await Store.setAccount(fuid,acct); }catch(e){ await ADLIEU_FB.deleteLogin().catch(()=>{}); throw new Error('Could not create the account. Please try again.'); }
      Store.use(fuid); profile=acct; f.reset(); $('#pwMeter').style.width='0';
      enterApp(); toast('Account created — welcome to ADLIEU, '+acct.name.split(' ')[0]+' ✨');
    }catch(e){ err.textContent=e.message||'Could not create the account. Please try again.'; }
    finally{ btn.disabled=false; btn.textContent='Create Account'; }
    return;
  }
  try{
    const u=await userKey(display);""")

# 5) login with Firebase Auth
rep("""  btn.disabled=true; btn.textContent='Logging in…';
  try{
    if(failCount>=3)""", """  btn.disabled=true; btn.textContent='Logging in…';
  if(Store.mode==='cloud'){
    try{
      if(!validUser(display)) throw new Error('Incorrect username or password.');
      const fuid=await ADLIEU_FB.login(display, f.password.value, f.remember.checked);
      let a=await Store.getAccount(fuid);
      if(!a){ a={ username:display, name:display, email:'', birthday:'', bio:'', beneficiary:{name:'',relation:''}, createdAt:new Date().toISOString() }; await Store.setAccount(fuid,a); }
      Store.use(fuid); profile=a; f.password.value='';
      enterApp(); toast('Welcome back, '+a.name.split(' ')[0]+' ♥');
    }catch(e){ err.textContent=e.message||'Could not log in right now. Please try again.'; f.password.value=''; }
    finally{ btn.disabled=false; btn.textContent='Log In'; }
    return;
  }
  try{
    if(failCount>=3)""")

# 6) logout signs out of Firebase too
rep("  Store.logout(); clearSession(); profile=null;", "  if(Store.mode==='cloud') ADLIEU_FB.logout();\n  Store.logout(); clearSession(); profile=null;")

# 7) change password via Firebase Auth
rep("""  ev.preventDefault(); const f=ev.target, err=$('#pwErr'); err.textContent='';
  if((await hashPassword(f.current.value,profile.passSalt)).hash!==profile.passHash) return err.textContent='Current password is incorrect.';""",
    """  ev.preventDefault(); const f=ev.target, err=$('#pwErr'); err.textContent='';
  if(Store.mode==='cloud'){
    if(f.password.value.length<6) return err.textContent='New password must be at least 6 characters.';
    if(f.password.value!==f.confirm.value) return err.textContent='New passwords do not match.';
    try{ await ADLIEU_FB.changePassword(f.current.value, f.password.value); f.reset(); toast('Password updated'); }
    catch(e){ err.textContent=/Incorrect/.test(e.message)?'Current password is incorrect.':e.message; }
    return;
  }
  if((await hashPassword(f.current.value,profile.passSalt)).hash!==profile.passHash) return err.textContent='Current password is incorrect.';""")

# 8) delete account: re-authenticate, delete data, delete the login
rep("  if((await hashPassword(pw,profile.passSalt)).hash!==profile.passHash) return err.textContent='That password is not correct.';",
    "  if(Store.mode==='cloud'){ try{ await ADLIEU_FB.reauth(pw); }catch(e){ return err.textContent=/Incorrect/.test(e.message)?'That password is not correct.':e.message; } }\n  else if((await hashPassword(pw,profile.passSalt)).hash!==profile.passHash) return err.textContent='That password is not correct.';")
rep("  try{ await Store.deleteAccount(); $('#delPw').value='';", "  try{ await Store.deleteAccount(); if(Store.mode==='cloud') await ADLIEU_FB.deleteLogin(); $('#delPw').value='';")

# 9) Adlieu AI through Cloud Functions (Perspective Lock runs on the server)
rep("    const r=await sample(hist,{tools,cache:false,onText:({text})=>{ ans.content=text; renderChat(); }});",
    "    const r=await ADLIEU_FB.chat({ message:q, history:win.slice(0,-1).map(m=>({role:m.role,content:String(m.content).slice(0,4000)})), allow:allowedVis(), today:todayISO() });\n    if(r.usedTools){ ans.tools='📖 Looked at your diary'; }")
rep("e?.code==='not_granted'?'Adlieu AI needs your permission to run. Please allow it and send again.'",
    "e?.code==='not_granted'?'Please log in again to chat with Adlieu AI.': e?.code==='ai_unavailable'?'Adlieu AI isn\\'t set up on this Firebase project yet (deploy the Cloud Functions and add the API key — see README).'")
rep("  try{ const r=await sample(prompt,{onText:({text})=>{ box.firstChild.textContent=text; }}); box.firstChild.textContent=r.text; }",
    "  try{ const r=await ADLIEU_FB.summarize({ entryId:e.id, today:todayISO() }); box.firstChild.textContent=r.summary; }")
rep("catch(err){ box.firstChild.textContent= err?.code==='rate_limited'?'Please try again in a minute.':'Couldn\\'t summarize right now.'; }",
    "catch(err){ box.firstChild.textContent= err?.code==='rate_limited'?'Please try again in a minute.': err?.code==='ai_unavailable'?'Adlieu AI isn\\'t set up on this Firebase project yet.':'Couldn\\'t summarize right now.'; }")

# 10) wording
rep("I can only chat when ADLIEU is opened inside claude.ai while you\\'re signed in. Your diary still works here — come back to chat with me there 💗",
    "I\\'m not available in this browser right now. Your diary still works — try again later 💗")
rep("<title>ADLIEU — A Personal AI Diary</title>", "<title>ADLIEU — A Personal AI Diary</title>\n<link rel=\"icon\" href=\"icon.png\">")

open(out, 'w', encoding='utf-8').write(s)
print('built', out, len(s), 'bytes')
