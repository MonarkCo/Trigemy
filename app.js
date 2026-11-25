"use strict";
/* Trigemy · Montaj Takibi
   Veri: depodaki data.json (şifreli). Herkes okur; düzenleme modunda GitHub anahtarıyla aynı dosyaya commit atılır.
   Yönetici planları: ozel.json, ayrı bir anahtarla şifreli; yalnız yönetici erişim anahtarları açar. */

const DURUMLAR = [
  { id: "bekliyor",    ad: "Montaj Bekliyor", renk: "--st-bekliyor" },
  { id: "montajda",    ad: "Montajda",        renk: "--st-montajda" },
  { id: "montajlandi", ad: "Montajlandı",     renk: "--st-montajlandi" },
  { id: "revize",      ad: "Revizede",        renk: "--st-revize" },
  { id: "yayinda",     ad: "Yayında",         renk: "--st-yayinda" },
];
const BITEN = new Set(["montajlandi", "yayinda"]);
const VIDEOLU = new Set(["montajlandi", "revize", "yayinda"]);   // montajlanınca Vimeo'ya konur, revize ve yayın aynı kartta sürer
const durumOf = (id) => DURUMLAR.find((d) => d.id === id) || DURUMLAR[0];
// revize akışının aşamaları (kartta herkese görünür; ayrıntı yalnız yöneticide)
const ASAMALAR = [
  { id: "geldi",     ad: "Geldi",     kart: "Revize geldi" },
  { id: "analiz",    ad: "Analiz",    kart: "İnceleniyor" },
  { id: "onay",      ad: "Onay",      kart: "İnceleniyor", yon: "Onayını bekliyor" },
  { id: "isleniyor", ad: "İşleniyor", kart: "İşleniyor" },
  { id: "hazir",     ad: "Hazır",     kart: "Hazır" },
];
const asamaIdx = (id) => Math.max(0, ASAMALAR.findIndex((a) => a.id === id));
// canlı iş adımı (r.is): video üzerinde çalışılırken herkese "şu an ne yapılıyor" gösterilir.
// Claude pano.mjs ile günceller; 8 saattir güncellenmeyen adım bayat sayılıp gösterilmez.
// sıra TRIGEMY kurgu akışı: hazırlık → analiz → kurgu → açı → slayt → renk → ses → kontrol → render → yükleme
const ISLER = [
  { id: "hazirlik", ad: "Hazırlanıyor" },
  { id: "analiz",   ad: "Kesim kararları veriliyor" },
  { id: "kurgu",    ad: "Kurgu yapılıyor" },
  { id: "aci",      ad: "Açı geçişleri yapılıyor" },
  { id: "slayt",    ad: "Slaytlar yerleştiriliyor" },
  { id: "renk",     ad: "Renk ayarı yapılıyor" },
  { id: "ses",      ad: "Ses düzenleniyor" },
  { id: "kontrol",  ad: "Son kontrol yapılıyor" },
  { id: "render",   ad: "Renderlanıyor" },
  { id: "yukleme",  ad: "Vimeo'ya yükleniyor" },
  { id: "revize",   ad: "Revizeler işleniyor", ayri: true },   // revize turu: adım çizgisinde yer almaz
];
const IS_OMUR = 8 * 3600e3;
function isOf(r) {
  const x = r && r.is;
  if (!x || !x.adim) return null;
  const ts = Date.parse(x.tarih) || 0;
  if (Date.now() - ts > IS_OMUR) return null;
  const d = ISLER.find((a) => a.id === x.adim);
  const yuzde = Number.isFinite(x.yuzde) ? Math.max(0, Math.min(100, Math.round(x.yuzde))) : null;
  return { adim: x.adim, ad: d ? d.ad : String(x.adim), yuzde, ts, tarih: x.tarih };
}
const isMetni = (w) => w.ad + (w.yuzde != null ? ` · %${w.yuzde}` : "");

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const CFG = Object.assign({ owner: "", repo: "", branch: "main", path: "data.json", api: "https://api.github.com" }, window.TRIGEMY || {});
if (!CFG.owner && location.hostname.endsWith(".github.io")) {
  CFG.owner = location.hostname.split(".")[0];
  CFG.repo = location.pathname.split("/").filter(Boolean)[0] || CFG.owner + ".github.io";
}
const REPO_API = CFG.owner && CFG.repo ? `${CFG.api}/repos/${CFG.owner}/${CFG.repo}` : "";
const API = REPO_API ? `${REPO_API}/contents/${CFG.path}` : "";
const OZEL_PATH = "ozel.json";
const OZEL_API = REPO_API ? `${REPO_API}/contents/${OZEL_PATH}` : "";
const TOKEN_KEY = "trigemy_gh_token";
const KEY_KEY = "trigemy_pano_anahtar";

const S = {
  data: { cekimler: [] }, sha: null, loaded: false,
  token: store.get(TOKEN_KEY), edit: false,
  view: store.get("trigemy_view") || (matchMedia("(max-width: 680px)").matches ? "liste" : "pano"),
  sekme: location.hash === "#yabanci" ? "yabanci" : location.hash === "#turkce" ? "tr" : store.get("trigemy_sekme") || "tr",
  tur: "", q: "", durumF: "", current: null, tab: "revize", saveTimer: null, saving: false, dirty: false,
  dek: null, enc: false, lastDoc: null, anahtarlar: [], myKeyId: null, myKeyStr: null, revize: {},   // dek: çözülmüş veri anahtarı
  ydek: null, ozel: null, ozelKeys: [], ozelSha: null, ozelDirty: false, secim: null,               // ydek: yönetici anahtarı
};

/* ---------- yardımcılar ---------- */
const $ = (s, r = document) => r.querySelector(s);
function h(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "text") n.textContent = v;
    else if (k === "style") n.style.cssText = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
  return n;
}
const svgNS = "http://www.w3.org/2000/svg";
function ico(d, size) {
  const s = document.createElementNS(svgNS, "svg");
  s.setAttribute("viewBox", "0 0 20 20"); s.setAttribute("class", "i"); s.setAttribute("aria-hidden", "true");
  if (size) s.style.cssText = `width:${size}px;height:${size}px`;
  s.innerHTML = d;
  return s;
}
const I = {
  play: '<path d="M7 4.5v11l9-5.5z" style="fill:currentColor;stroke:none"/>',
  rev: '<path d="M4 4h12v9H8l-4 3z"/>',
  yor: '<circle cx="10" cy="10" r="6.5"/><path d="M7.5 9h5M7.5 11.5h3"/>',
  cal: '<rect x="3.5" y="4.5" width="13" height="12" rx="2"/><path d="M3.5 8.5h13M7 2.5v4M13 2.5v4"/>',
  chk: '<path d="m4.5 10.5 3.5 3.5 7.5-8"/>',
  chk2: '<path d="m5 10.5 3.2 3 6.8-7" style="stroke-width:2.4"/>',
  spark: '<path d="M10 2.5l1.8 4.2 4.2 1.8-4.2 1.8L10 14.5l-1.8-4.2L4 8.5l4.2-1.8z"/>',
  lock: '<rect x="4.5" y="9" width="11" height="8" rx="2"/><path d="M7 9V6.5a3 3 0 0 1 6 0V9"/>',
  dl: '<path d="M10 3.5v9M6 9l4 4 4-4M4 16.5h12"/>',
};
const cssVar = (name) => `var(${name})`;
const trLower = (s) => (s || "").toLocaleLowerCase("tr");
function fmtGun(iso) {
  if (!iso) return "";
  const d = new Date(iso); if (isNaN(d)) return "";
  return d.toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" });
}
function fmtKisa(iso) {
  if (!iso) return "";
  const d = new Date(iso); if (isNaN(d)) return "";
  return d.toLocaleDateString("tr-TR", { day: "numeric", month: "short" });
}
function fmtGoreli(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime(); if (isNaN(t)) return "";
  const dk = Math.round((Date.now() - t) / 60000);
  if (dk < 1) return "az önce";
  if (dk < 60) return dk + " dk önce";
  const sa = Math.round(dk / 60);
  if (sa < 24) return sa + " saat önce";
  const g = Math.round(sa / 24);
  if (g === 1) return "dün";
  if (g < 7) return g + " gün önce";
  return fmtKisa(iso);
}
const fmtSaatKisa = (ts) => new Date(ts).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
const bugunMu = (ts) => new Date(ts).toDateString() === new Date().toDateString();
const anOf = (ts) => (bugunMu(ts) ? "bugün " + fmtSaatKisa(ts) : fmtGoreli(new Date(ts).toISOString()));
// dil boşsa Türkçe; yabancı dil konuşan hocalar ayrı sekmede
const yabanci = (r) => !!r.dil && trLower(r.dil) !== "türkçe";
const sekmede = (r) => yabanci(r) === (S.sekme === "yabanci");
const cekimAdi = (r) => r.ad || (r.tur === "Ofis" ? "Ofis Çekimi" : r.tur + " Çekim");
const b64enc = (str) => { const b = new TextEncoder().encode(str); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const b64dec = (b64) => new TextDecoder().decode(b64bytes(b64));
const b64bytes = (b64) => Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0));
const bytesb64 = (b) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };

// avatar: adın baş harfleri, addan türeyen sabit renk çifti
const GRAD = [["#7383ff", "#a37bff"], ["#43c58c", "#1f8f9b"], ["#f5a547", "#e0603d"], ["#b08cff", "#ff7ab6"], ["#4fb6ff", "#7383ff"], ["#ff8a65", "#f5a547"], ["#36c2c2", "#4f7cff"]];
const THUMB = ["linear-gradient(135deg,#2c3a6e,#141a2e 60%,#2b2140)", "linear-gradient(135deg,#1e4a44,#0f1a1e 60%,#22314a)", "linear-gradient(135deg,#4a3420,#16120e 60%,#3a2234)", "linear-gradient(135deg,#3b2a5e,#121020 60%,#1f3350)"];
const hashOf = (s) => { let x = 0; for (const c of s || "") x = (x * 31 + c.charCodeAt(0)) >>> 0; return x; };
const basHarf = (s) => (s || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toLocaleUpperCase("tr");
const avStyle = (s) => { const g = GRAD[hashOf(s) % GRAD.length]; return `--a1:${g[0]};--a2:${g[1]}`; };
const av = (s, cls) => h("span", { class: "av" + (cls ? " " + cls : ""), style: avStyle(s), "aria-hidden": "true", text: basHarf(s) });

/* ---------- şifreleme ----------
   Veri rastgele bir veri anahtarıyla (AES-GCM) şifreli. Her erişim anahtarı bu veri anahtarını ayrı ayrı sarar;
   anahtar silinince onun sargısı da silinir, o kişi bir daha açamaz. Biçim sifrele.mjs ile aynı.
   ozel.json da aynı biçimde; ama onun anahtarını yalnız yönetici erişim anahtarları sarar. */
const KDF_ITER = 100000;
const ALFABE = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const normKey = (s) => (s || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
function yeniAnahtar() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => ALFABE[x % ALFABE.length]).join("").match(/.{4}/g).join("-");
}
async function kek(n, salt, iter) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(n), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function unwrapDek(doc, keyStr) {
  const n = normKey(keyStr);
  if (n.length < 12) return null;
  for (const a of doc.anahtarlar || []) {
    try {
      const k = await kek(n, b64bytes(a.salt), a.iter || KDF_ITER);
      const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64bytes(a.iv) }, k, b64bytes(a.k));
      return { dek: await crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]), id: a.id };
    } catch { /* bu sargı değil, sıradakine bak */ }
  }
  return null;
}
async function wrapEntry(id, keyStr, dek) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const raw = await crypto.subtle.exportKey("raw", dek);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await kek(normKey(keyStr), salt, KDF_ITER), raw);
  return { id, iter: KDF_ITER, salt: bytesb64(salt), iv: bytesb64(iv), k: bytesb64(new Uint8Array(ct)) };
}
async function decryptDoc(doc, dek) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64bytes(doc.iv) }, dek, b64bytes(doc.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
async function encryptDoc(obj, dek, anahtarlar) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, dek, new TextEncoder().encode(JSON.stringify(obj)));
  return { sifreli: true, v: 2, iv: bytesb64(iv), ct: bytesb64(new Uint8Array(ct)), anahtarlar };
}

/* ---------- veri ---------- */
async function load({ quiet = false } = {}) {
  try {
    // İzleyiciler sitedeki kopyayı okur: GitHub API'nin anahtarsız kotası (saatte 60) aynı internet bağlantısındaki
    // herkes için ortak, ofisten 3-4 kişi bakınca doluyordu. Düzenleyen kişi (GitHub anahtarıyla) API'den okur:
    // sha ona lazım, site kopyası her kayıttan ~1 dk sonra yenilenir.
    let text = null;
    if (!S.token) {
      try { const r = await fetch(CFG.path + "?t=" + Date.now(), { cache: "no-store" }); if (r.ok) text = await r.text(); } catch {}
    }
    if (text == null && API) {
      const headers = { Accept: "application/vnd.github+json" };
      const tok = S.token || (REV() && REV().token);
      if (tok) headers.Authorization = "Bearer " + tok;
      const r = await fetch(`${API}?ref=${encodeURIComponent(CFG.branch)}`, { headers, cache: "no-store" });
      if (r.ok) { const j = await r.json(); S.sha = j.sha; text = b64dec(j.content); }
      else if (r.status === 401 && S.token) { logout("GitHub anahtarı geçersiz ya da süresi dolmuş. Yeniden bağlan."); }
    }
    if (text == null) throw new Error("data.json okunamadı");
    if (S.dirty || S.saving) return;   // kaydedilmemiş değişikliğin üstüne yazma
    const doc = JSON.parse(text);
    if (doc && doc.sifreli) {
      S.lastDoc = doc; S.anahtarlar = doc.anahtarlar || [];
      let plain = null;
      if (S.dek) { try { plain = await decryptDoc(doc, S.dek); } catch { S.dek = null; } }
      if (!plain && store.get(KEY_KEY)) {
        const u = await unwrapDek(doc, store.get(KEY_KEY));
        if (u) { S.dek = u.dek; S.myKeyId = u.id; S.myKeyStr = store.get(KEY_KEY); plain = await decryptDoc(doc, S.dek); }
        else store.set(KEY_KEY, null);   // anahtar silinmiş
      }
      if (!plain) { showLock(); return; }
      S.enc = true;
      setData(plain, doc.anahtarlar);
    } else {
      S.enc = false;
      setData(doc);
    }
    showMain();
    S.loaded = true;
    if (!quiet) banner("");
    render();
    loadRevize().then(() => { autoRevize(); render(); });
    loadOzel().then(render);
  } catch (e) {
    S.loaded = true;
    if (!S.data.cekimler.length) render();
    banner("Veriler yüklenemedi. Bağlantını kontrol edip sayfayı yenile.", "--danger");
    console.error(e);
  }
}
function normalize(d) {
  d = d && typeof d === "object" ? d : {};
  d.cekimler = Array.isArray(d.cekimler) ? d.cekimler.filter((x) => x && typeof x === "object") : [];
  for (const r of d.cekimler) {
    r.id = String(r.id || uid());
    if (!DURUMLAR.some((x) => x.id === r.durum)) r.durum = "bekliyor";
    if (!Array.isArray(r.gecmis)) r.gecmis = [];
  }
  return d;
}
const uid = () => "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const clone = (o) => JSON.parse(JSON.stringify(o));
// S.base: depodan en son okunan/yazılan hal. Aynı anda başka biri kaydederse, bu tabana göre yalnız bizim değiştirdiğimiz
// kartlar onun halinin üstüne yazılır (eskiden bizim bütün halimiz onunkini siliyordu).
function setData(plain, anahtarlar) {
  S.data = normalize(plain); S.base = clone(S.data);
  if (anahtarlar) { S.anahtarlar = anahtarlar; S.baseKeys = clone(anahtarlar); }
}
const ayni = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function mergeList(base, mine, theirs) {
  const B = new Map((base || []).map((x) => [x.id, x])), M = new Map((mine || []).map((x) => [x.id, x]));
  const out = [], seen = new Set();
  for (const t of theirs || []) {
    seen.add(t.id);
    const b = B.get(t.id), m = M.get(t.id);
    if (!m) { if (!(b && ayni(b, t))) out.push(t); continue; }   // biz sildik; o arada onlar değiştirdiyse onlarınki kalır
    out.push(b && ayni(b, m) ? t : m);                             // biz dokunmadıysak onlarınki, dokunduysak bizimki
  }
  for (const m of mine || []) if (!seen.has(m.id) && (!B.has(m.id) || !ayni(B.get(m.id), m))) out.push(m);   // bizim eklediğimiz
  return out;
}
function mergeData(base, mine, theirs) {
  const out = { ...theirs };
  for (const k of ["cekimler", "erisim"]) out[k] = mergeList(base[k], mine[k], theirs[k]);
  if (!ayni(base.yukleme, mine.yukleme)) out.yukleme = mine.yukleme;
  out.guncelleme = mine.guncelleme;
  return out;
}

function mutate(fn, ozet) {
  fn();
  S.data.guncelleme = new Date().toISOString();
  S.dirty = true;   // ozet yalnız okunurluk için: depo herkese açık, kayıt açıklaması hep "Pano güncellendi"
  render();
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(save, 700);
  syncChip("Kaydediliyor…", "var(--st-revize)");
}

async function save(retry = true) {
  if (!S.token || !API) return;
  if (S.saving) { clearTimeout(S.saveTimer); S.saveTimer = setTimeout(save, 500); return; }
  S.saving = true; S.dirty = false;
  try {
    const sent = clone(S.data), sentKeys = clone(S.anahtarlar);
    const out = S.enc ? await encryptDoc(sent, S.dek, sentKeys) : sent;
    const body = JSON.stringify(out, null, 2) + "\n";
    const r = await fetch(API, {
      method: "PUT",
      headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + S.token, "Content-Type": "application/json" },
      // depo herkese açık: açıklamaya hoca adı yazılmaz (veri şifreli, açıklama değil)
      body: JSON.stringify({ message: "Pano güncellendi", content: b64enc(body), sha: S.sha || undefined, branch: CFG.branch }),
    });
    if (r.ok) {
      S.sha = (await r.json()).content.sha;
      S.base = sent; S.baseKeys = sentKeys;
      syncChip("Kaydedildi", "var(--ok)");
    } else if ((r.status === 409 || r.status === 422) && retry) {
      // dosya o arada başka biri tarafından kaydedilmiş: güncel hali oku, bizim değişikliklerimizi onun üstüne birleştir
      const g = await fetch(`${API}?ref=${encodeURIComponent(CFG.branch)}`, { headers: { Authorization: "Bearer " + S.token }, cache: "no-store" });
      if (!g.ok) throw new Error("güncel hal okunamadı: HTTP " + g.status);
      const j = await g.json(), doc = JSON.parse(b64dec(j.content));
      const theirs = normalize(doc.sifreli ? await decryptDoc(doc, S.dek) : doc);
      S.sha = j.sha;
      S.data = mergeData(S.base, S.data, theirs);
      if (doc.sifreli) S.anahtarlar = mergeList(S.baseKeys, S.anahtarlar, doc.anahtarlar);
      S.base = clone(theirs); S.baseKeys = clone(doc.anahtarlar || []);
      render();
      S.saving = false; return save(false);
    } else if (r.status === 401 || r.status === 403 || r.status === 404) {
      S.dirty = true;
      syncChip("Kaydedilemedi", "var(--danger)");
      banner("Kaydedilemedi: GitHub anahtarının bu depoya yazma izni yok (Contents: Read and write).", "--danger");
    } else throw new Error("HTTP " + r.status);
  } catch (e) {
    S.dirty = true;
    syncChip("Kaydedilemedi", "var(--danger)");
    banner("Değişiklik kaydedilemedi. İnternet bağlantısını kontrol et; sayfayı kapatmadan tekrar dene.", "--danger");
    console.error(e);
  } finally { S.saving = false; }
}

/* ---------- yönetici planları (ozel.json) ----------
   Revize gelince Claude maddeleri okur, kurgudaki yerlerine eşler ve bir plan yazar. Plan, hocaların anahtarıyla
   açılamayan ayrı bir dosyadadır: { planlar: { <çekim>: { asama, ozet, maddeler:[{tc,sn,metin,tur,durum}], onay } } }.
   Anahtarını yalnız "yönetici" işaretli erişim anahtarları sarar (pano sahibi ve Claude). */
const isAdmin = () => !!S.ydek;
const planOf = (id) => (S.ozel && S.ozel.planlar && S.ozel.planlar[id]) || null;
async function loadOzel() {
  if (!S.enc || !S.myKeyStr) return;
  try {
    let doc = null;
    if (S.token && OZEL_API) {
      const r = await fetch(`${OZEL_API}?ref=${encodeURIComponent(CFG.branch)}`, { headers: { Authorization: "Bearer " + S.token, Accept: "application/vnd.github+json" }, cache: "no-store" });
      if (r.ok) { const j = await r.json(); S.ozelSha = j.sha; doc = JSON.parse(b64dec(j.content)); }
      else if (r.status === 404) { S.ozelSha = null; await ozelKur(); return; }
    } else {
      const r = await fetch(OZEL_PATH + "?t=" + Date.now(), { cache: "no-store" });
      if (r.ok) doc = await r.json();
    }
    if (!doc || !doc.sifreli || S.ozelDirty) return;
    const u = S.ydek ? { dek: S.ydek } : await unwrapDek(doc, S.myKeyStr);
    if (!u) return;   // bu anahtar yönetici değil
    S.ydek = u.dek; S.ozelKeys = doc.anahtarlar || [];
    S.ozel = Object.assign({ planlar: {} }, await decryptDoc(doc, S.ydek));
    if (dlg.open) refreshItem();
  } catch (e) { console.error(e); }
}
// ozel.json yoksa: pano sahibi düzenleme moduna ilk girdiğinde kurulur, yalnız onun anahtarı açar
async function ozelKur() {
  if (!S.edit || !S.myKeyStr || !S.myKeyId || S.ydek) return;
  S.ydek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  S.ozelKeys = [await wrapEntry(S.myKeyId, S.myKeyStr, S.ydek)];
  S.ozel = { planlar: {} };
  const me = (S.data.erisim || []).find((x) => x.id === S.myKeyId);
  if (me && !me.yonetici) mutate(() => { me.yonetici = true; }, "Yönetici anahtarı işaretlendi");
  await saveOzel();
}
async function saveOzel(retry = true) {
  if (!S.token || !OZEL_API || !S.ydek) return false;
  S.ozelDirty = true;
  try {
    const body = JSON.stringify(await encryptDoc(S.ozel, S.ydek, S.ozelKeys), null, 2) + "\n";
    const r = await fetch(OZEL_API, {
      method: "PUT", headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + S.token, "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Pano güncellendi", content: b64enc(body), sha: S.ozelSha || undefined, branch: CFG.branch }),
    });
    if (r.ok) { S.ozelSha = (await r.json()).content.sha; S.ozelDirty = false; return true; }
    if ((r.status === 409 || r.status === 422) && retry) {
      // Claude o arada planı güncellemiş: güncel hali oku, çekim başına daha yeni olanı tut
      const g = await fetch(`${OZEL_API}?ref=${encodeURIComponent(CFG.branch)}`, { headers: { Authorization: "Bearer " + S.token }, cache: "no-store" });
      if (!g.ok) throw new Error("HTTP " + g.status);
      const j = await g.json(), doc = JSON.parse(b64dec(j.content)), theirs = await decryptDoc(doc, S.ydek);
      const out = { ...theirs, planlar: { ...(theirs.planlar || {}) } };
      for (const [id, p] of Object.entries(S.ozel.planlar || {})) {
        const t = out.planlar[id];
        if (!t || (p.guncelleme || "") >= (t.guncelleme || "")) out.planlar[id] = p;
      }
      const ids = new Set(S.ozelKeys.map((x) => x.id));
      S.ozelKeys = [...S.ozelKeys, ...(doc.anahtarlar || []).filter((x) => !ids.has(x.id) && (S.data.erisim || []).some((e) => e.id === x.id))];
      S.ozel = out; S.ozelSha = j.sha;
      return await saveOzel(false);
    }
    throw new Error("HTTP " + r.status);
  } catch (e) {
    console.error(e);
    S.ozelDirty = false;
    banner("Gizli plan kaydedilemedi. Bağlantını kontrol edip tekrar dene.", "--danger");
    return false;
  }
}
function planMutate(id, fn) {
  const p = planOf(id); if (!p) return;
  fn(p); p.guncelleme = new Date().toISOString();
  refreshItem();
  saveOzel().then(() => refreshItem());
}

/* ---------- revize durumu ----------
   Montajlandı ya da Yayında'daki bir karta, son durum değişikliğinden sonra revize isteği gelirse kart herkeste
   kendiliğinden Revizede'ye geçer (kayıt beklemeden). Pano sahibi düzenleme modundaysa ya da revize bekçisi
   çalışınca bu durum kalıcı olarak kaydedilir. */
const revlerOf = (r) => { const e = revOf(r.id); return [...e.dosyalar, ...e.notlar.filter((n) => n.tur === "revize")]; };
const yorumlarOf = (r) => revOf(r.id).notlar.filter((n) => n.tur === "yorum");
const sonDurumTs = (r) => Date.parse(r.gecmis.length ? r.gecmis[r.gecmis.length - 1].tarih : r.guncelleme) || 0;
// bu revize turunun başlangıcı: kartın en son Revizede dışı bir aşamaya geçtiği an
const turBasi = (r) => { for (let i = r.gecmis.length - 1; i >= 0; i--) if (r.gecmis[i].durum !== "revize") return Date.parse(r.gecmis[i].tarih) || 0; return 0; };
const sonRevTs = (r) => revlerOf(r).reduce((m, x) => Math.max(m, x.ts), 0);
// otomatik taşıma bu özellik açıldıktan sonra gelen revizeler için: daha eski revizeler zaten elle işlendi
const OTO_BASLANGIC = Date.parse("2026-11-25T00:00:00+03:00");
function etkin(r) {
  const son = sonRevTs(r);
  if (BITEN.has(r.durum) && son > OTO_BASLANGIC && son > sonDurumTs(r)) return "revize";
  return r.durum;
}
function asamaOf(r) {
  if (r.durum !== "revize") return "geldi";
  const a = r.rev && r.rev.asama;
  if (!a) return "geldi";
  if ((a === "isleniyor" || a === "hazir") && sonRevTs(r) > (Date.parse(r.rev.tarih) || 0)) return "geldi";   // işlenirken yeni revize geldi
  return a;
}
const sicak = (r) => etkin(r) === "revize" && ["geldi", "analiz", "onay"].includes(asamaOf(r));
const yeniRevler = (r) => revlerOf(r).filter((x) => x.ts > turBasi(r));
function autoRevize() {
  if (!S.edit || !S.loaded) return;
  const now = new Date().toISOString();
  const kayan = S.data.cekimler.filter((r) => etkin(r) === "revize" && r.durum !== "revize");
  const tazele = S.data.cekimler.filter((r) => r.durum === "revize" && r.rev && asamaOf(r) !== r.rev.asama);
  if (!kayan.length && !tazele.length) return;
  mutate(() => {
    for (const r of kayan) { r.durum = "revize"; r.guncelleme = now; r.gecmis.push({ durum: "revize", tarih: now, oto: true }); r.rev = { asama: "geldi", tarih: now }; }
    for (const r of tazele) r.rev = { asama: "geldi", tarih: now };
  }, "Revize gelen kartlar Revizede'ye geçti");
}

/* ---------- görünüm ---------- */
function banner(text, color) {
  const b = $("#banner");
  b.textContent = text || ""; b.hidden = !text;
  if (color) b.style.setProperty("--c", cssVar(color));
}
function syncChip(text, color) {
  const s = $("#sync");
  if (!S.edit) { s.hidden = true; renderLive(); return; }
  s.hidden = false; s.textContent = text; s.style.setProperty("--c", color);
  $("#live").hidden = true;
}
function renderLive() {
  const upd = S.data.guncelleme;
  $("#live").hidden = S.edit || !upd || !S.loaded;
  $("#live-t").textContent = upd ? "Güncellendi · " + fmtGoreli(upd) : "";
}
function visible(r) {
  if (S.tur && r.tur !== S.tur) return false;
  if (S.q && !trLower(r.egitmen).includes(S.q) && !trLower(r.ad).includes(S.q)) return false;
  return true;
}
const bySira = (a, b) => (a.sira ?? 1e9) - (b.sira ?? 1e9) || (a.egitmen || "").localeCompare(b.egitmen || "", "tr");

function render() {
  const yab = S.data.cekimler.filter(yabanci).length;
  $("#tab-tr-n").textContent = String(S.data.cekimler.length - yab);
  $("#tab-yab-n").textContent = String(yab);
  for (const b of document.querySelectorAll("[data-sekme]")) b.setAttribute("aria-selected", String(b.dataset.sekme === S.sekme));
  const all = S.data.cekimler.filter(sekmede);
  const n = all.length;
  const sayi = Object.fromEntries(DURUMLAR.map((d) => [d.id, all.filter((r) => etkin(r) === d.id).length]));
  const biten = sayi.montajlandi + sayi.yayinda;
  const pct = n ? Math.round((biten / n) * 100) : 0;

  // başlık ve genel durum
  const egitmen = new Set(all.map((r) => trLower(r.egitmen))).size;
  $("#head-sub").textContent = !S.loaded ? "Veriler yükleniyor…" : `${S.sekme === "yabanci" ? "Yabancı dil eğitmenleri" : "Türkçe eğitmenler"} · ${n} çekim · ${egitmen} eğitmen`;
  countTo($("#pct"), pct);
  $("#done-line").textContent = !S.loaded ? "" : n ? `tamamlandı · ${n} çekimden ${biten} tanesi bitti` : S.sekme === "yabanci" ? "Henüz yabancı dil çekimi eklenmedi" : "Henüz çekim eklenmedi";
  const track = $("#track"), sig = DURUMLAR.map((d) => sayi[d.id]).join(",");
  if (track.dataset.sig !== sig) {
    track.dataset.sig = sig;
    track.replaceChildren(...DURUMLAR.filter((d) => sayi[d.id]).map((d, i) => h("i", { title: `${d.ad}: ${sayi[d.id]}`, style: `--c:${cssVar(d.renk)};--n:${sayi[d.id]};--d:${i * 90}ms` })));
  }
  $("#legend").replaceChildren(...DURUMLAR.map((d) => h("button", {
    type: "button", style: `--c:${cssVar(d.renk)}`, "aria-pressed": String(S.durumF === d.id), title: S.durumF === d.id ? "Süzmeyi kaldır" : "Yalnız bu aşamayı göster",
    onclick: () => { S.durumF = S.durumF === d.id ? "" : d.id; render(); },
  }, h("i"), d.ad, h("b", { text: String(sayi[d.id]) }))));
  renderStats(all);
  renderNow(all);
  renderAlerts(all);

  $("#foot-upd").textContent = S.data.guncelleme ? "Son güncelleme: " + fmtGun(S.data.guncelleme) : "";
  renderLive();

  // görünümler
  $("#view-pano").hidden = S.view !== "pano";
  $("#view-liste").hidden = S.view !== "liste";
  for (const b of document.querySelectorAll("[data-view]")) b.setAttribute("aria-pressed", String(b.dataset.view === S.view));
  $("#btn-add").hidden = !S.edit;
  $("#btn-keys").hidden = !(S.edit && S.enc);
  $("#btn-forget").hidden = !S.enc;
  $("#btn-mode").textContent = S.edit ? "Düzenlemeyi kapat" : "Düzenle";

  const rows = all.filter(visible).filter((r) => !S.durumF || etkin(r) === S.durumF).sort(bySira);
  if (S.view === "pano") renderBoard(rows); else renderTable(rows);
}
function countTo(el, v) {
  const from = +el.dataset.v || 0;
  el.dataset.v = String(v);
  if (from === v) { el.textContent = String(v); return; }
  const t0 = performance.now();
  const step = (t) => { const k = Math.min(1, (t - t0) / 700); el.textContent = String(Math.round(from + (v - from) * (1 - Math.pow(1 - k, 3)))); if (k < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
  setTimeout(() => { if (el.dataset.v === String(v)) el.textContent = String(v); }, 800);   // arka plandaki sekmede rAF durursa
}
function renderStats(all) {
  const stat = (c, icon, label, val, right) => h("div", { class: "stat", style: `--c:${cssVar(c)}` },
    h("span", { class: "ic" }, ico(icon)), h("div", null, h("p", { text: label }), h("b", { text: val, title: val })), right != null ? h("span", { class: "r", text: String(right) }) : null);
  // açık revize
  const acik = all.filter((r) => etkin(r) === "revize");
  const madde = acik.reduce((s, r) => s + yeniRevler(r).length, 0);
  // sıradaki teslim: bitmemiş çekimlerin en yakın teslim tarihi
  const gun0 = new Date(); gun0.setHours(0, 0, 0, 0);
  const teslim = all.filter((r) => r.teslim && (r.durum === "bekliyor" || r.durum === "montajda")).sort((a, b) => a.teslim.localeCompare(b.teslim))[0];
  const kalan = teslim ? Math.round((new Date(teslim.teslim + "T00:00") - gun0) / 86400000) : null;
  // bu hafta tamamlanan
  const hafta = Date.now() - 7 * 86400000;
  const bitenler = all.filter((r) => r.gecmis.some((g) => BITEN.has(g.durum) && Date.parse(g.tarih) > hafta));
  $("#stats").replaceChildren(
    stat("--st-revize", I.rev, "Açık revize", acik.length ? `${acik.length} çekimde${madde ? ` · ${madde} istek` : ""}` : "Bekleyen revize yok", acik.length),
    stat(kalan != null && kalan < 0 ? "--danger" : "--st-montajda", I.cal, kalan != null && kalan < 0 ? "Teslim tarihi geçti" : "Sıradaki teslim",
      teslim ? `${teslim.egitmen} · ${fmtKisa(teslim.teslim)}` : "Planlı teslim yok", kalan == null ? null : kalan === 0 ? "bugün" : Math.abs(kalan) + "g"),
    stat("--st-montajlandi", I.chk, "Son 7 günde biten", bitenler.length ? bitenler.map((r) => r.egitmen).join(", ") : "Bu hafta biten yok", bitenler.length),
  );
}
// herkese: şu an üzerinde çalışılan videolar
function renderNow(all) {
  const box = $("#now");
  const list = all.map((r) => ({ r, w: isOf(r) })).filter((x) => x.w).sort((a, b) => b.w.ts - a.w.ts);
  box.replaceChildren(...list.map(({ r, w }) => {
    const hat = ISLER.filter((a) => !a.ayri), ai = hat.findIndex((a) => a.id === w.adim);
    return h("button", { class: "now-row", type: "button", onclick: () => openItem(r.id) },
      h("span", { class: "now-dot" }),
      av(r.egitmen, "md"),
      h("div", { class: "txt" }, h("b", { text: isMetni(w) }), h("p", { text: `${r.egitmen} · ${cekimAdi(r)}` })),
      h("span", { class: "sp" }),
      ai >= 0 ? h("div", { class: "now-steps", "aria-hidden": "true" }, hat.map((s, i) => h("i", { class: i < ai ? "on" : i === ai ? "now" : "", title: s.ad }))) : null,
      h("small", { class: "when", text: fmtGoreli(w.tarih) }),
      w.yuzde != null ? h("span", { class: "now-bar", style: `--p:${w.yuzde}%` }) : null);
  }));
  box.hidden = !list.length;
}
// pano sahibine: revize gelen, henüz işlenmeye başlamamış çekimler
function renderAlerts(all) {
  const box = $("#alerts");
  if (!isAdmin() && !S.edit) { box.replaceChildren(); return; }
  const list = all.filter(sicak).sort((a, b) => sonRevTs(b) - sonRevTs(a)).slice(0, 4);
  box.replaceChildren(...list.map((r) => {
    const yeni = yeniRevler(r), son = yeni.slice().sort((a, b) => b.ts - a.ts)[0];
    const a = asamaOf(r), ai = asamaIdx(a), plan = planOf(r.id);
    const avEl = av(r.egitmen, "md"), baslik = h("b", { text: `${r.egitmen} · ${yeni.length || revlerOf(r).length} yeni revize` });
    const alt = h("p", { text: (r.durum === "revize" ? "Kart Revizede'ye geçti" : "Kart kendiliğinden Revizede'ye geçti") + (son ? " · " + anOf(son.ts) : "") });
    if (son && !son.eski) notOku(son.path).then((k) => {
      if (!k || !k.yazan || !avEl.isConnected) return;
      avEl.replaceWith(av(k.yazan, "md"));
      baslik.textContent = `${k.yazan}, ${r.egitmen} videosuna ${yeni.length} revize gönderdi`;
    }).catch(() => {});
    return h("div", { class: "alert" }, avEl,
      h("div", { class: "txt" }, baslik, alt), h("span", { class: "sp" }),
      h("div", { class: "steps-mini", "aria-label": "Revize aşaması" }, ASAMALAR.flatMap((s, i) => [
        i ? h("em") : null, h("span", { class: i < ai ? "ok" : i === ai ? "now" : "" }, h("i"), s.id === "onay" ? "Onayın" : s.ad)]).filter(Boolean)),
      h("button", { class: "btn " + (plan && a === "onay" ? "warm" : ""), type: "button", text: plan && a === "onay" ? "Planı gör" : "Aç", onclick: () => openItem(r.id, { tab: "revize" }) }));
  }));
}

function renderBoard(rows) {
  const board = $("#view-pano");
  const cols = S.durumF ? DURUMLAR.filter((d) => d.id === S.durumF) : DURUMLAR;
  board.classList.toggle("tek", !!S.durumF);
  let k = 0;
  board.replaceChildren(...cols.map((d) => {
    const items = rows.filter((r) => etkin(r) === d.id);
    const col = h("section", { class: "col", style: `--c:${cssVar(d.renk)}`, "aria-label": d.ad },
      h("div", { class: "col-h" }, h("i"), h("h3", { text: d.ad }), h("span", { class: "n", text: String(items.length) })),
      h("div", { class: "cards" }, !S.loaded ? [h("div", { class: "skel" }), h("div", { class: "skel" })] :
        items.length ? items.map((r) => card(r, k++)) : h("div", { class: "empty", text: S.edit ? "Kartı buraya sürükle" : "Bu aşamada çekim yok" })),
    );
    if (S.edit) {
      col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("over"); });
      col.addEventListener("dragleave", (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove("over"); });
      col.addEventListener("drop", (e) => { e.preventDefault(); col.classList.remove("over"); setDurum(e.dataTransfer.getData("text/plain"), d.id); });
    }
    return col;
  }));
}

function card(r, i) {
  const st = etkin(r), v = vimeoParse(r.vimeo);
  const revN = revlerOf(r).length, yorN = yorumlarOf(r).length;
  const acik = r.durum === "bekliyor" || r.durum === "montajda";
  const gec = r.teslim && acik && new Date(r.teslim + "T23:59") < new Date();
  const w = isOf(r);
  const c = h("article", { class: "card" + (isAdmin() && sicak(r) ? " hot" : "") + (w ? " working" : "") + (S.current === r.id && dlg.open ? " sel" : ""), tabindex: "0", draggable: S.edit ? "true" : null,
    "data-id": r.id, style: `--d:${Math.min(i, 14) * 30}ms`, "aria-label": `${r.egitmen}, ${cekimAdi(r)}, ${durumOf(st).ad}` },
    v ? vimeoThumb(r, v) : S.edit && VIDEOLU.has(st) ? vimeoPaste(r) : null,
    h("div", { class: "who" }, av(r.egitmen), h("div", null, h("b", { text: r.egitmen || "İsimsiz" }), h("small", { text: cekimAdi(r) })), r.sira ? h("span", { class: "no", text: "#" + r.sira }) : null),
    st === "revize" ? flowEl(r) : w ? nowLine(w) : null,
    r.not && S.edit ? h("div", { class: "card-note", text: r.not }) : null,
    h("div", { class: "meta" },
      yabanci(r) ? h("span", { class: "tag lang", text: r.dil }) : null,
      r.teslim && acik ? h("span", { class: "tag " + (gec ? "late" : "due") }, h("span", { class: "d" }), (gec ? "Gecikti · " : "Teslim ") + fmtKisa(r.teslim)) : null,
      revN && st !== "revize" ? h("span", { class: "tag rev", title: "Revize isteği" }, ico(I.rev, 12), String(revN)) : null,
      yorN ? h("span", { class: "tag", title: "Yorum" }, ico(I.yor, 12), String(yorN)) : null,
      h("span", { class: "when", text: fmtGoreli(r.guncelleme) })),
  );
  c.addEventListener("click", () => openItem(r.id));
  c.addEventListener("keydown", (e) => { if (e.target === c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openItem(r.id); } });
  if (S.edit) {
    c.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", r.id); e.dataTransfer.effectAllowed = "move"; c.classList.add("dragging"); });
    c.addEventListener("dragend", () => c.classList.remove("dragging"));
  }
  return c;
}
function flowEl(r) {
  const a = asamaOf(r), ai = asamaIdx(a), as = ASAMALAR[ai];
  const n = yeniRevler(r).length, plan = isAdmin() ? planOf(r.id) : null;
  let sag = n ? `${n} istek` : "";
  if (plan && plan.maddeler && plan.maddeler.length) sag = `${plan.maddeler.length} madde`;
  if (a === "isleniyor" && r.rev && r.rev.n) sag = `${r.rev.bitti || 0} / ${r.rev.n}`;
  // işlenirken canlı adım (Renderlanıyor, Vimeo'ya yükleniyor…) aşama adının yerine geçer
  const w = (a === "isleniyor" || a === "hazir") ? isOf(r) : null;
  return h("div", { class: "flow" + (w ? " canli" : "") },
    h("div", { class: "row" }, ASAMALAR.map((s, i) => h("i", { class: i < ai ? "on" : i === ai ? (a === "hazir" && !w ? "on" : "now") : "" }))),
    h("p", null, w ? h("em", null, h("i"), isMetni(w)) : (isAdmin() && as.yon) || as.kart, h("span", { text: sag })));
}
function nowLine(w) {
  return h("div", { class: "now-line" + (w.yuzde != null ? " pct" : ""), style: w.yuzde != null ? `--p:${w.yuzde}%` : null },
    h("i"), h("span", { text: isMetni(w) }), h("small", { text: fmtGoreli(w.tarih) }));
}

function renderTable(rows) {
  const tb = $("#rows");
  if (!S.loaded) { tb.replaceChildren(h("tr", null, h("td", { colspan: "6" }, h("div", { class: "skel line" })))); return; }
  if (!rows.length) { tb.replaceChildren(h("tr", null, h("td", { colspan: "6", class: "dim", text: "Aramaya uyan çekim yok." }))); return; }
  tb.replaceChildren(...rows.map((r) => {
    const st = etkin(r), d = durumOf(st), revN = revlerOf(r).length, w = isOf(r);
    const tr = h("tr", { tabindex: "0" },
      h("td", { class: "name" }, h("div", { class: "who" }, av(r.egitmen), h("div", null, h("b", { text: r.egitmen }), r.sira ? h("small", { text: "#" + r.sira }) : null))),
      h("td", { class: "dim" }, yabanci(r) ? r.dil + " · " : "", cekimAdi(r)),
      h("td", null, h("span", { class: "pill", style: `--c:${cssVar(d.renk)}`, text: d.ad + (w ? " · " + w.ad.toLocaleLowerCase("tr") : st === "revize" ? " · " + ASAMALAR[asamaIdx(asamaOf(r))].kart.toLocaleLowerCase("tr") : "") })),
      h("td", { class: "dim", text: r.teslim ? fmtKisa(r.teslim) : "—" }),
      h("td", { class: "dim", text: revN ? String(revN) : "—" }),
      h("td", { class: "dim", text: fmtGoreli(r.guncelleme) }),
    );
    tr.addEventListener("click", () => openItem(r.id));
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter") openItem(r.id); });
    return tr;
  }));
}

function setDurum(id, durum) {
  const r = S.data.cekimler.find((x) => x.id === id);
  if (!r || !S.edit) return;
  if (r.durum === durum && etkin(r) === durum) return;
  mutate(() => {
    const now = new Date().toISOString();
    r.durum = durum; r.guncelleme = now; r.gecmis.push({ durum, tarih: now });
    if (durum === "revize") r.rev = { asama: "geldi", tarih: now }; else delete r.rev;
    delete r.is;   // elle taşınınca canlı iş adımı biter
  }, `${r.egitmen} (${cekimAdi(r)}) → ${durumOf(durum).ad}`);
  if (dlg.open && S.current === id) refreshItem();
  if (VIDEOLU.has(durum) && !r.vimeo) openItem(id, { tab: "bilgi", focus: "#f-vimeo" });   // montajlanan videonun Vimeo linki
}

/* ---------- çekim paneli ---------- */
const dlg = $("#dlg-item");
for (const d of DURUMLAR) $("#f-durum").append(h("option", { value: d.id, text: d.ad }));

function openItem(id, opts = {}) {
  const r = id ? S.data.cekimler.find((x) => x.id === id) : null;
  S.current = r ? r.id : null;
  S.secim = null;
  if (!r) S.tab = "bilgi";
  else if (opts.tab) S.tab = opts.tab;
  else S.tab = VIDEOLU.has(etkin(r)) || revlerOf(r).length ? "revize" : yorumlarOf(r).length ? "yorum" : "bilgi";

  // düzenleme formu
  $("#f-egitmen").value = r?.egitmen || "";
  $("#f-tur").value = r?.tur || "Teorik";
  $("#f-durum").value = r?.durum || "bekliyor";
  $("#f-sira").value = r?.sira ?? "";
  $("#f-teslim").value = r?.teslim || "";
  $("#f-ad").value = r?.ad || "";
  $("#f-dil").value = r ? r.dil || "Türkçe" : S.sekme === "yabanci" ? "İngilizce" : "Türkçe";
  $("#f-not").value = r?.not || "";
  $("#f-link").value = r?.link || "";
  $("#f-vimeo").value = r?.vimeo || "";
  $("#f-err").textContent = "";
  $("#f-vimeo-hint").textContent = "";
  $("#del-confirm").hidden = true;

  showMedia(r ? vimeoParse(r.vimeo) : null, opts);
  refreshItem(opts);
  if (!dlg.open) dlg.showModal();
  $(".d-b").scrollTop = 0;
  for (const c of document.querySelectorAll(".card")) c.classList.toggle("sel", c.dataset.id === S.current);
  if (S.edit && !r) $("#f-egitmen").focus();
  if (S.edit && opts.focus) setTimeout(() => $(opts.focus).focus(), 50);
}
// paneli o anki veriyle yeniden çizer (formdaki yazılara dokunmaz)
function refreshItem(opts = {}) {
  if (!dlg.open && !opts) return;
  const r = S.current && S.data.cekimler.find((x) => x.id === S.current);
  if (!r && !S.edit) return;
  const st = r ? etkin(r) : "bekliyor";
  const a = $("#item-av");
  a.textContent = r ? basHarf(r.egitmen) : "+"; a.setAttribute("style", avStyle(r ? r.egitmen : "Yeni"));
  $("#item-title").textContent = r ? r.egitmen : "Yeni çekim";
  $("#item-eyebrow").textContent = r ? [yabanci(r) ? r.dil : null, cekimAdi(r), r.sira ? "#" + r.sira : null, r.teslim && (r.durum === "bekliyor" || r.durum === "montajda") ? "Teslim " + fmtKisa(r.teslim) : null].filter(Boolean).join(" · ") : "Bilgileri doldurup kaydet";

  // durum
  $("#item-status").hidden = !r;
  if (r) $("#item-status").replaceChildren(...DURUMLAR.map((d) => h("button", {
    type: "button", style: `--c:${cssVar(d.renk)}`, "aria-pressed": String(st === d.id), disabled: !S.edit,
    title: S.edit ? `${d.ad} aşamasına taşı` : null, onclick: () => setDurum(r.id, d.id),
  }, h("i"), d.ad)));
  const wi = r && isOf(r);
  $("#item-now").hidden = !wi;
  if (wi) $("#item-now").replaceChildren(nowLine(wi));

  // sekmeler
  const tabs = $("#item-tabs");
  tabs.hidden = !r;
  if (r) {
    refreshTabsCount(r);
    for (const b of tabs.querySelectorAll("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === S.tab));
  }
  const thread = !!r && (S.tab === "revize" || S.tab === "yorum");
  $("#item-thread-pane").hidden = !thread;
  $("#item-view").hidden = !r || S.tab !== "bilgi" || S.edit;
  const formda = S.edit && (S.tab === "bilgi" || !r);
  $("#item-edit").hidden = !formda;
  $("#edit-acts").hidden = !formda;
  $("#btn-del").hidden = !r;

  // indirme linki
  const link = r && safeUrl(r.link);
  $("#item-dl").replaceChildren(...(link ? [h("a", { class: "btn", href: link, target: "_blank", rel: "noopener noreferrer" }, ico(I.dl), "Videoyu indir")] : []));
  $("#item-foot").hidden = !link && !formda;

  renderPlan(r);
  if (r && S.tab === "bilgi" && !S.edit) renderFacts(r);
  if (thread) renderExtra(r);
  else $("#item-revplan").replaceChildren();
  renderRail();
}
for (const b of document.querySelectorAll("#item-tabs [data-tab]")) b.addEventListener("click", () => { S.tab = b.dataset.tab; refreshItem(); });

function renderFacts(r) {
  const st = etkin(r), d = durumOf(st);
  const fact = (label, val) => h("div", { class: "fact" }, h("span", { text: label }), typeof val === "string" ? h("b", { text: val }) : val);
  $("#item-view").replaceChildren(...[
    h("div", { class: "facts" },
      fact("Durum", h("span", { class: "pill", style: `--c:${cssVar(d.renk)}`, text: d.ad })),
      fact("Çekim", cekimAdi(r)),
      fact("Teslim", r.teslim ? fmtGun(r.teslim) : "—"),
      fact("Dil", r.dil || "Türkçe")),
    r.not ? [h("p", { class: "sec-title", text: "Not" }), h("div", { class: "note-box", text: r.not })] : null,
    r.gecmis.length ? [h("p", { class: "sec-title", text: "Süreç" }),
      h("ol", { class: "timeline" }, [...r.gecmis].reverse().map((g) => h("li", { style: `--c:${cssVar(durumOf(g.durum).renk)}` },
        h("span", null, durumOf(g.durum).ad, g.oto ? h("small", { text: " · revize gelince otomatik" }) : null), h("time", { datetime: g.tarih, text: fmtGun(g.tarih) }))))] : null,
  ].flat().filter(Boolean));
}

// yönetici: Claude'un planı (hocalar görmez; ozel.json'dan gelir)
const TURLER = [["kesim", "kesim"], ["aci", "açı"], ["ses", "ses"], ["slayt", "slayt / grafik"], ["renk", "renk"], ["cekim", "yeniden çekim"], ["diger", "diğer"]];
const turAd = (t) => (TURLER.find((x) => x[0] === t) || [t, t])[1];
function renderPlan(r) {
  const box = $("#item-plan"), p = r && isAdmin() ? planOf(r.id) : null;
  if (!p || etkin(r) !== "revize") { box.replaceChildren(); return; }
  const m = p.maddeler || [];
  const say = {}; for (const x of m) say[x.tur || "diger"] = (say[x.tur || "diger"] || 0) + 1;
  const soru = m.filter((x) => x.durum === "soru").length, yapildi = m.filter((x) => x.durum === "yapildi").length;
  const acts = h("div", { class: "acts" });
  if (p.onay) {
    acts.append(h("span", { class: "ok-line", text: `Onaylandı · ${fmtGoreli(p.onay.tarih)}${p.onay.secilen ? ` · ${p.onay.secilen.length} madde` : ""}${yapildi ? ` · ${yapildi}/${m.length} yapıldı` : ""}` }));
  } else if (m.length) {
    if (S.secim) {
      acts.append(
        h("button", { class: "btn pri", type: "button", text: `Seçilen ${S.secim.size} maddeyi onayla`, disabled: !S.secim.size, onclick: () => onayla(r, [...S.secim].sort((a, b) => a - b)) }),
        h("button", { class: "btn", type: "button", text: "Vazgeç", onclick: () => { S.secim = null; refreshItem(); } }));
    } else {
      acts.append(
        h("button", { class: "btn pri", type: "button", text: "Onayla, başla", onclick: () => onayla(r, null) }),
        h("button", { class: "btn", type: "button", text: "Maddeleri seç", onclick: () => { S.secim = new Set(m.map((_, i) => i).filter((i) => m[i].durum !== "soru")); S.tab = "revize"; refreshItem(); } }));
    }
  }
  box.replaceChildren(h("div", { class: "private" },
    h("div", { class: "ph" }, ico(I.spark), "Claude'un planı", h("span", { class: "lock-tag" }, ico(I.lock, 12), "Yalnız sen")),
    h("p", { text: p.ozet || `${m.length} madde okundu ve kurgudaki yerlerine eşlendi.${soru ? ` ${soru} madde senin kararın.` : ""}` }),
    m.length ? h("div", { class: "kinds" }, TURLER.filter(([t]) => say[t]).map(([t, ad]) => h("div", null, h("b", { text: String(say[t]) }), ad))) : null,
    acts));
}
async function onayla(r, secilen) {
  if (!S.edit) { banner("Onaylamak için önce Düzenle ile düzenleme modunu aç.", "--st-revize"); return; }
  const now = new Date().toISOString();
  const n = secilen ? secilen.length : (planOf(r.id).maddeler || []).length;
  S.secim = null;
  planMutate(r.id, (p) => { p.onay = { tarih: now, secilen }; p.asama = "onaylandi"; });
  mutate(() => { r.rev = { asama: "isleniyor", tarih: now, n, bitti: 0 }; }, `${r.egitmen} revize planı onaylandı`);
  refreshItem();
}
function planList(r) {
  const p = isAdmin() ? planOf(r.id) : null;
  if (!p || !(p.maddeler || []).length || etkin(r) !== "revize") return [];
  const out = [];
  const gruplar = TURLER.map(([t]) => t).concat([...new Set(p.maddeler.map((x) => x.tur || "diger"))].filter((t) => !TURLER.some((x) => x[0] === t)));
  for (const t of gruplar) {
    const items = p.maddeler.map((x, i) => [x, i]).filter(([x]) => (x.tur || "diger") === t);
    if (!items.length) continue;
    out.push(h("div", { class: "grp", text: turAd(t) }));
    for (const [x, i] of items) {
      const sec = S.secim ? S.secim.has(i) : null;
      const done = sec != null ? sec : x.durum === "yapildi";
      const ck = h("span", { class: "ck", role: "checkbox", "aria-checked": String(done), title: S.secim ? "Plana dahil et" : "Yapıldı olarak işaretle" }, ico(I.chk2, 12));
      ck.addEventListener("click", (e) => {
        e.stopPropagation();
        if (S.secim) { S.secim.has(i) ? S.secim.delete(i) : S.secim.add(i); refreshItem(); return; }
        if (!S.edit) return;
        planMutate(r.id, (pp) => { pp.maddeler[i].durum = pp.maddeler[i].durum === "yapildi" ? "plan" : "yapildi"; });
      });
      const row = h("div", { class: "it" + (done ? " done" : ""), "data-i": String(i) }, ck,
        x.tc ? h("span", { class: "tc", text: x.tc }) : h("span"),
        h("p", { text: x.metin || "" }),
        h("span", { class: "s" + (x.durum === "soru" ? " ask" : ""), text: x.durum === "yapildi" ? "Yapıldı" : x.durum === "soru" ? "Sana soruldu" : "Planda", title: x.not || null }));
      row.addEventListener("click", () => { if (Number.isFinite(x.sn)) seek(x.sn); markRail("p" + i); });
      out.push(row);
    }
  }
  out.push(h("div", { class: "grp", text: "Gelen istekler" }));
  return out;
}

$("#item-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!S.edit) return dlg.close();
  const egitmen = $("#f-egitmen").value.trim();
  if (!egitmen) { $("#f-err").textContent = "Eğitmen adını yaz."; return; }
  const sira = parseInt($("#f-sira").value, 10);
  const val = {
    egitmen, tur: $("#f-tur").value, durum: $("#f-durum").value, sira: Number.isFinite(sira) ? sira : null,
    teslim: $("#f-teslim").value, ad: $("#f-ad").value.trim(), dil: trLower($("#f-dil").value.trim()) === "türkçe" ? "" : $("#f-dil").value.trim(), not: $("#f-not").value.trim(),
    link: $("#f-link").value.trim(),
  };
  if (val.link && !safeUrl(val.link)) { $("#f-err").textContent = "İndirme linki http:// ya da https:// ile başlamalı."; return; }
  const vraw = $("#f-vimeo").value.trim(), vv = vimeoParse(vraw);
  if (vraw && !vv) { $("#f-err").textContent = "Vimeo linki tanınmadı. vimeo.com/… biçiminde bir link yapıştır."; return; }
  val.vimeo = vv ? vv.url : "";
  const now = new Date().toISOString();
  const r = S.current && S.data.cekimler.find((x) => x.id === S.current);
  if (r) {
    mutate(() => {
      if (r.durum !== val.durum) { r.gecmis.push({ durum: val.durum, tarih: now }); if (val.durum === "revize") r.rev = { asama: "geldi", tarih: now }; else delete r.rev; delete r.is; }
      delete r.disk;   // eski "medya başka diskte" alanı artık kullanılmıyor
      Object.assign(r, val, { guncelleme: now });
    }, `${val.egitmen} (${cekimAdi(val)}) güncellendi`);
  } else {
    mutate(() => S.data.cekimler.push({ id: uid(), ...val, guncelleme: now, gecmis: [{ durum: val.durum, tarih: now }] }),
      `${val.egitmen} (${cekimAdi(val)}) eklendi`);
  }
  dlg.close();
});
$("#btn-del").addEventListener("click", () => { $("#del-confirm").hidden = false; $("#btn-del").hidden = true; });
$("#btn-del-yes").addEventListener("click", () => {
  const r = S.data.cekimler.find((x) => x.id === S.current);
  if (r) mutate(() => { S.data.cekimler = S.data.cekimler.filter((x) => x.id !== r.id); }, `${r.egitmen} (${cekimAdi(r)}) silindi`);
  dlg.close();
});
for (const b of document.querySelectorAll("[data-close]")) b.addEventListener("click", () => b.closest("dialog").close());
for (const d of document.querySelectorAll("dialog")) d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
dlg.addEventListener("close", () => { S.secim = null; for (const c of document.querySelectorAll(".card.sel")) c.classList.remove("sel"); });

/* ---------- düzenleme modu ---------- */
const authDlg = $("#dlg-auth");
$("#btn-mode").addEventListener("click", () => {
  if (S.edit) { S.edit = false; syncChip(); render(); if (dlg.open) refreshItem(); return; }
  if (!API) { banner("GitHub deposu ayarlı değil: index.html içindeki TRIGEMY ayarını doldur.", "--danger"); return; }
  if (S.token) { enterEdit(); return; }
  $("#f-token").value = ""; $("#auth-err").textContent = "";
  authDlg.showModal();
});
$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const tok = $("#f-token").value.trim();
  if (!tok) return;
  $("#btn-auth").disabled = true; $("#auth-err").textContent = "";
  try {
    const r = await fetch(REPO_API, { headers: { Authorization: "Bearer " + tok, Accept: "application/vnd.github+json" } });
    if (!r.ok) throw new Error(r.status === 401 ? "Anahtar geçersiz." : "Bu anahtar depoyu göremiyor.");
    const j = await r.json();
    if (j.permissions && !j.permissions.push) throw new Error("Bu anahtarın depoya yazma izni yok.");
    S.token = tok; store.set(TOKEN_KEY, tok);
    authDlg.close();
    enterEdit();
  } catch (err) { $("#auth-err").textContent = err.message || "Bağlanılamadı."; }
  finally { $("#btn-auth").disabled = false; }
});
async function enterEdit() {
  S.edit = true;
  syncChip("Bağlanıyor…", "var(--st-revize)");
  render();
  await load({ quiet: true });          // güncel hali ve sha'yı al
  syncChip("Düzenleme açık", "var(--ok)");
  if (dlg.open) refreshItem();
}
function logout(msg) {
  S.token = null; S.edit = false; store.set(TOKEN_KEY, null);
  syncChip(); render();
  if (msg) banner(msg, "--danger");
}

/* ---------- kilit ve erişim anahtarları ---------- */
function showLock() {
  S.edit = false; syncChip();
  $("#main").hidden = true; $("#lock").hidden = false; $("#btn-mode").hidden = true; $("#tabs").hidden = true; $("#cmd").hidden = true;
  $("#lock-pass").value = ""; $("#lock-err").textContent = "";
  $("#lock-pass").focus();
}
function showMain() { $("#lock").hidden = true; $("#main").hidden = false; $("#btn-mode").hidden = false; $("#tabs").hidden = false; $("#cmd").hidden = false; }
$("#lock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("#lock-pass").value;
  if (!key || !S.lastDoc) return;
  $("#lock-btn").disabled = true; $("#lock-err").textContent = "";
  try {
    const u = await unwrapDek(S.lastDoc, key);
    if (!u) throw new Error("yanlış");
    const plain = await decryptDoc(S.lastDoc, u.dek);
    S.dek = u.dek; S.myKeyId = u.id; S.myKeyStr = normKey(key); S.enc = true;
    if ($("#lock-remember").checked) store.set(KEY_KEY, normKey(key));
    setData(plain, S.lastDoc.anahtarlar); S.loaded = true;
    showMain(); banner(""); render();
    loadRevize().then(() => { autoRevize(); render(); });
    loadOzel().then(render);
  } catch { $("#lock-err").textContent = "Anahtar geçersiz."; $("#lock-pass").select(); }
  finally { $("#lock-btn").disabled = false; }
});
$("#btn-forget").addEventListener("click", () => {
  store.set(KEY_KEY, null); S.dek = null; S.ydek = null; S.ozel = null; S.myKeyStr = null; S.data = { cekimler: [] };
  if (S.lastDoc) showLock();
});

const keysDlg = $("#dlg-keys");
const siteUrl = () => location.origin + location.pathname;
function renderKeys() {
  const list = (S.data.erisim || []).slice().sort((a, b) => (a.olusturma || "").localeCompare(b.olusturma || ""));
  $("#key-list").replaceChildren(...list.map((k) => {
    const mine = k.id === S.myKeyId;
    const del = h("button", { class: "btn danger small", type: "button", text: "Sil", disabled: mine || list.length < 2,
      title: mine ? "Şu an bu anahtarla girdin" : list.length < 2 ? "Son anahtar silinemez" : null });
    const yes = h("button", { class: "btn danger solid small", type: "button", text: "Evet, sil", hidden: true });
    del.addEventListener("click", () => { del.hidden = true; yes.hidden = false; });
    yes.addEventListener("click", () => {
      mutate(() => {
        S.data.erisim = S.data.erisim.filter((x) => x.id !== k.id);
        S.anahtarlar = S.anahtarlar.filter((x) => x.id !== k.id);
      }, `Erişim anahtarı silindi: ${k.ad}`);
      if (S.ozelKeys.some((x) => x.id === k.id)) { S.ozelKeys = S.ozelKeys.filter((x) => x.id !== k.id); saveOzel(); }
      renderKeys();
    });
    return h("li", { class: "key-row" },
      h("div", { class: "key-info" }, h("b", { text: k.ad || "İsimsiz" }),
        k.yonetici ? h("span", { class: "chip", style: "--c:var(--st-revize)", text: "Yönetici" }) : null,
        mine ? h("span", { class: "chip", text: "Bu cihaz" }) : null,
        h("small", { text: "Oluşturma: " + fmtGun(k.olusturma) })),
      h("div", { class: "key-actions" }, del, yes));
  }));
  $("#key-count").textContent = list.length + " anahtar";
  $("#keyadmin-row").hidden = !isAdmin();
}
$("#btn-keys").addEventListener("click", () => {
  $("#key-new").hidden = true; $("#f-keyname").value = ""; $("#f-keyadmin").checked = false; $("#key-err").textContent = "";
  renderKeys(); renderRevSettings(); keysDlg.showModal();
});
$("#key-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ad = $("#f-keyname").value.trim(), yon = $("#f-keyadmin").checked && isAdmin();
  if (!ad) { $("#key-err").textContent = "Anahtarın kimin için olduğunu yaz."; return; }
  if (!S.dek) return;
  $("#btn-keygen").disabled = true; $("#key-err").textContent = "";
  try {
    const key = yeniAnahtar(), id = uid();
    const entry = await wrapEntry(id, key, S.dek);
    if (yon) {
      S.ozelKeys.push(await wrapEntry(id, key, S.ydek));
      if (!(await saveOzel())) { S.ozelKeys = S.ozelKeys.filter((x) => x.id !== id); throw new Error("ozel"); }
    }
    mutate(() => {
      S.anahtarlar.push(entry);
      (S.data.erisim ||= []).push({ id, ad, olusturma: new Date().toISOString(), ...(yon ? { yonetici: true } : {}) });
    }, `Erişim anahtarı eklendi: ${ad}`);
    $("#key-value").textContent = key;
    $("#key-for").textContent = ad + (yon ? " · yönetici" : "");
    $("#key-new").hidden = false; $("#f-keyname").value = ""; $("#f-keyadmin").checked = false;
    renderKeys();
  } catch { $("#key-err").textContent = "Anahtar üretilemedi."; }
  finally { $("#btn-keygen").disabled = false; }
});
async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); const t = btn.textContent; btn.textContent = "Kopyalandı"; setTimeout(() => (btn.textContent = t), 1500); }
  catch { btn.textContent = "Kopyalanamadı"; }
}
$("#btn-copy-key").addEventListener("click", (e) => copy($("#key-value").textContent, e.currentTarget));
$("#btn-copy-msg").addEventListener("click", (e) => copy(
  `Trigemy montaj takibi: ${siteUrl()}\nErişim anahtarınız: ${$("#key-value").textContent}`, e.currentTarget));

/* ---------- Vimeo ----------
   Yayındaki video Vimeo linkiyle gelir: link (ya da gömme kodu) yapıştırılınca oynatıcı ve küçük resim kendiliğinden çıkar.
   Liste dışı (unlisted) videolarda linkteki gizli kod (vimeo.com/<id>/<kod>) korunur. */
const VIMEO_SDK = "https://cdn.jsdelivr.net/npm/@vimeo/player@2.30.4/dist/player.min.js";
function vimeoParse(s) {
  s = (s || "").trim();
  const src = s.match(/src=["']([^"']+)["']/i); if (src) s = src[1];
  if (!/vimeo\.com\//i.test(s)) return null;
  let u; try { u = new URL(/^https?:\/\//i.test(s) ? s : "https://" + s.replace(/^\/+/, "")); } catch { return null; }
  if (!/(^|\.)vimeo\.com$/i.test(u.hostname)) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  const i = parts.findIndex((p) => /^\d{5,}$/.test(p));
  if (i < 0) return null;
  const id = parts[i], next = parts[i + 1] || "";
  const hash = (u.searchParams.get("h") || (/^[0-9a-f]{6,}$/i.test(next) ? next : "")).replace(/[^0-9a-f]/gi, "");
  return {
    id, hash, url: `https://vimeo.com/${id}${hash ? "/" + hash : ""}`,
    embed: `https://player.vimeo.com/video/${id}?${hash ? "h=" + hash + "&" : ""}title=0&byline=0&portrait=0&dnt=1`,
  };
}
const OEMBED = new Map();
function vimeoInfo(v) {
  if (!OEMBED.has(v.url)) OEMBED.set(v.url, fetch(`https://vimeo.com/api/oembed.json?width=960&url=${encodeURIComponent(v.url)}`)
    .then((r) => (r.ok ? r.json() : null)).catch(() => null));
  return OEMBED.get(v.url);
}
const thumbUrl = (d) => (d && /^https:\/\/i\.vimeocdn\.com\/[^\s"'()\\]+$/.test(d.thumbnail_url || "") ? d.thumbnail_url : "");
function fmtSure(sn) {
  sn = Math.max(0, Math.floor(sn || 0));
  const s = String(sn % 60).padStart(2, "0"), m = Math.floor(sn / 60) % 60, sa = Math.floor(sn / 3600);
  return sa ? `${sa}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
const fmtTc = (sn) => { sn = Math.max(0, Math.floor(sn || 0)); return [Math.floor(sn / 3600), Math.floor(sn / 60) % 60, sn % 60].map((x) => String(x).padStart(2, "0")).join(":"); };

function vimeoThumb(r, v) {
  const dur = h("span", { class: "du" }), marks = h("span", { class: "marks", hidden: true });
  const b = h("button", { class: "thumb", type: "button", style: `--g:${THUMB[hashOf(r.egitmen) % THUMB.length]}`, "aria-label": `${r.egitmen} videosunu izle`,
    onclick: (e) => { e.stopPropagation(); openItem(r.id, { play: true }); } }, h("span", { class: "pl", "aria-hidden": "true" }, ico(I.play, 12)), marks, dur);
  vimeoInfo(v).then((d) => {
    const t = thumbUrl(d); if (t) b.style.backgroundImage = `url("${t}")`;
    if (d && d.duration) {
      dur.textContent = fmtSure(d.duration);
      // önbellekteki revize zamanları (panel açılınca okunanlar) kart üstünde nokta olur
      const sn = (etkin(r) === "revize" ? yeniRevler(r) : []).map((x) => NOTLAR.get(x.path)).filter((k) => k && Number.isFinite(k.sn)).map((k) => k.sn);
      const p = isAdmin() && etkin(r) === "revize" && planOf(r.id); if (p) for (const x of p.maddeler || []) if (Number.isFinite(x.sn)) sn.push(x.sn);
      if (sn.length) { marks.hidden = false; marks.replaceChildren(...sn.map((s) => h("i", { style: `left:${Math.min(100, (s / d.duration) * 100)}%` }))); }
    }
  });
  return b;
}
// yönetici: montajlanan karta linki doğrudan yapıştırır
function vimeoPaste(r) {
  const inp = h("input", { class: "card-paste", type: "url", inputmode: "url", autocomplete: "off", spellcheck: "false",
    placeholder: "Vimeo linkini yapıştır", "aria-label": `${r.egitmen} için Vimeo linki`,
    onclick: (e) => e.stopPropagation(), onkeydown: (e) => { e.stopPropagation(); if (e.key === "Enter") apply(); } });
  function apply() {
    const v = vimeoParse(inp.value), dolu = !!inp.value.trim();
    inp.classList.toggle("bad", dolu && !v);
    inp.title = dolu && !v ? "Bu bir Vimeo linki değil" : "";
    if (v) mutate(() => { r.vimeo = v.url; r.guncelleme = new Date().toISOString(); }, `${r.egitmen} (${cekimAdi(r)}) Vimeo videosu eklendi`);
  }
  inp.addEventListener("paste", () => setTimeout(apply, 0));
  inp.addEventListener("change", apply);
  return inp;
}

// panelde oynatıcı; zaman kodu için Vimeo'nun oynatıcı kütüphanesi yalnız gerektiğinde yüklenir
const P = { el: null, embed: "", player: null, t: 0, dur: 0, sdk: null };
function loadSdk() {
  if (window.Vimeo && window.Vimeo.Player) return Promise.resolve();
  return (P.sdk ||= new Promise((res, rej) => document.head.append(h("script", { src: VIMEO_SDK, onload: res, onerror: () => { P.sdk = null; rej(); } }))));
}
function showMedia(v, opts = {}) {
  if (!v) { stopMedia(); return; }
  if (P.embed === v.embed && P.el && P.el.isConnected) return;   // aynı video zaten açık
  stopMedia();
  const ifr = h("iframe", { src: v.embed + (opts.play ? "&autoplay=1" : ""), title: "Vimeo videosu", allowfullscreen: true,
    allow: "autoplay; fullscreen; picture-in-picture; clipboard-write", referrerpolicy: "strict-origin-when-cross-origin" });
  const box = $("#item-media");
  box.replaceChildren(h("div", { class: "player" }, ifr),
    h("div", { class: "media-bar" }, h("span", { id: "rail-t", text: "0:00" }), h("div", { class: "rail", id: "rail" }, h("span", { class: "pos" })), h("span", { id: "rail-d", text: "" }),
      h("a", { href: v.url, target: "_blank", rel: "noopener noreferrer", title: "Vimeo'da aç" }, "Vimeo ↗")));
  box.hidden = false;
  P.el = ifr; P.embed = v.embed; P.t = 0; P.dur = 0;
  vimeoInfo(v).then((d) => { if (d && d.duration && P.el === ifr) { P.dur = d.duration; $("#rail-d").textContent = fmtSure(d.duration); renderRail(); } });
  loadSdk().then(() => {
    if (P.el !== ifr) return;
    const p = new window.Vimeo.Player(ifr);
    P.player = p;
    p.getDuration().then((d) => { if (d && P.el === ifr) { P.dur = d; $("#rail-d").textContent = fmtSure(d); renderRail(); } }).catch(() => {});
    p.on("timeupdate", (d) => { P.t = d.seconds; tick(); });
    p.on("seeked", (d) => { P.t = d.seconds; tick(); });
  }).catch(() => {});
}
function tick() {
  stampLabel();
  const t = $("#rail-t"), pos = $("#rail .pos");
  if (t) t.textContent = fmtSure(P.t);
  if (pos && P.dur) pos.style.width = Math.min(100, (P.t / P.dur) * 100) + "%";
}
function stopMedia() {
  if (P.player) { try { P.player.destroy(); } catch {} }
  P.el = null; P.embed = ""; P.player = null; P.t = 0; P.dur = 0;
  const box = $("#item-media"); box.replaceChildren(); box.hidden = true;
}
function seek(sn) {
  if (!P.player) return;
  P.player.setCurrentTime(sn).then(() => P.player.play()).catch(() => {});
}
// oynatıcının altındaki çubuk: revize / plan maddeleri nokta olarak, tıklanınca o ana gider
function renderRail() {
  const rail = $("#rail"), r = S.current && S.data.cekimler.find((x) => x.id === S.current);
  if (!rail || !r || !P.dur) return;
  const pts = [];
  const p = isAdmin() && etkin(r) === "revize" ? planOf(r.id) : null;
  if (p) (p.maddeler || []).forEach((x, i) => { if (Number.isFinite(x.sn)) pts.push({ key: "p" + i, sn: x.sn, cls: x.durum === "yapildi" ? "done" : "", t: (x.tc || fmtTc(x.sn)) + " · " + (x.metin || "") }); });
  for (const it of revOf(r.id).notlar) {
    const k = NOTLAR.get(it.path);
    if (k && Number.isFinite(k.sn) && (it.tur === "revize" ? !p && S.tab !== "yorum" : S.tab === "yorum")) pts.push({ key: it.path, sn: k.sn, cls: it.tur === "yorum" ? "yor" : "", t: fmtSure(k.sn) + " · " + (k.metin || "").slice(0, 80) });
  }
  rail.replaceChildren(h("span", { class: "pos", style: `width:${Math.min(100, (P.t / P.dur) * 100)}%` }),
    ...pts.map((x) => h("button", { type: "button", class: x.cls, "data-k": x.key, title: x.t, "aria-label": x.t, style: `left:${Math.min(100, (x.sn / P.dur) * 100)}%`,
      onclick: () => { seek(x.sn); markRail(x.key); } })));
}
function markRail(key) {
  for (const b of document.querySelectorAll("#rail button")) b.classList.toggle("on", b.dataset.k === key);
  for (const e of document.querySelectorAll("#item-revplan .it")) e.classList.toggle("on", "p" + e.dataset.i === key);
}
function stampLabel() {
  const t = $("#c-stamp-t"), c = $("#c-stamp");
  if (!t) return;
  t.textContent = fmtSure(P.t) + " anına bağla";
  if (c && !c.dataset.elle && P.t >= 1) c.checked = true;   // video oynatıldıysa yorum o ana bağlanır (kişi kapatmadıysa)
}
function vimeoHint() {
  const raw = $("#f-vimeo").value.trim(), v = vimeoParse(raw), hint = $("#f-vimeo-hint");
  hint.style.color = "";
  if (!raw) hint.textContent = "";
  else if (!v) { hint.style.color = "var(--danger)"; hint.textContent = "Bu bir Vimeo linki değil. Ör. https://vimeo.com/123456789"; }
  else {
    hint.style.color = "var(--ok)"; hint.textContent = "Video bulundu.";
    vimeoInfo(v).then((d) => {
      if ($("#f-vimeo").value.trim() !== raw) return;
      hint.textContent = d && d.title ? `Video bulundu: ${d.title}` : "Video bulundu. Oynatıcı açılmazsa Vimeo'da videonun gömme (embed) iznini kontrol et.";
    });
  }
  if (dlg.open) showMedia(v);
}
$("#f-vimeo").addEventListener("input", vimeoHint);
// pencere hangi yoldan kapanırsa kapansın video da durur; close olayı arka plandaki sekmede gecikebiliyor
new MutationObserver(() => { if (!dlg.open) stopMedia(); }).observe(dlg, { attributes: true, attributeFilter: ["open"] });

/* ---------- yorumlar ve revizeler ----------
   Hocalar ve ekip ayrı bir depoya (ör. Trigemy-revize) yazar; yalnız o depoya yazabilen anahtar şifreli veride durur.
   Her kayıt veri anahtarıyla şifreli ayrı bir dosyadır, aynı anda yazanlar çakışmaz:
     <çekim>/yorum/<zaman>-<rastgele>.enc    yorum
     <çekim>/revize/<zaman>-<rastgele>.enc   revize isteği (isteğe bağlı ek dosyayla)
     <çekim>/ek/<zaman>-<rastgele>.enc       revize isteğine eklenen dosya
     <çekim>/<zaman>-<rastgele>.enc          eski sürümde tek başına yüklenen revize dosyası
   Yazanın adı, girdiği erişim anahtarının adıdır (yönetici her kişiye ayrı anahtar üretir). */
const REV = () => (S.data.yukleme && S.data.yukleme.token && S.data.yukleme.repo ? S.data.yukleme : null);
const safeUrl = (u) => (/^https?:\/\/[^\s]+$/i.test(u || "") ? u : "");
const MAX_DOSYA = 15 * 1024 * 1024;
const revApi = (y, path = "") => `${CFG.api}/repos/${y.repo}/contents/${path}`;
const revHeaders = (y, raw) => ({ Authorization: "Bearer " + y.token, Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json" });
const NOTLAR = new Map();    // yol → çözülmüş kayıt (kayıt dosyaları değişmez, önbellek güvenli)
const SHA = new Map();       // yol → dosya sha'sı (silmek için)
const BEKLEYEN = new Map();  // yeni yazılan, depo listesine henüz düşmemiş kayıtlar
const SILINEN = new Map();   // silinen, depo listesinden henüz düşmemiş kayıtlar
const revOf = (id) => S.revize[id] || { dosyalar: [], notlar: [] };
const benimAdim = () => ((S.data.erisim || []).find((x) => x.id === S.myKeyId) || {}).ad || "İsimsiz";
const rid = () => Math.random().toString(36).slice(2, 8);
const fmtSaat = (ts) => new Date(ts).toLocaleString("tr-TR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

async function sifreleBayt(plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, S.dek, plain));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return out;
}
const cozBayt = async (buf) => new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.subarray(0, 12) }, S.dek, buf.subarray(12)));

async function revPut(path, bytes, message) {
  const y = REV();
  for (let i = 0; ; i++) {
    const r = await fetch(revApi(y, path), {
      method: "PUT", headers: { ...revHeaders(y), "Content-Type": "application/json" },
      body: JSON.stringify({ message, content: bytesb64(bytes), branch: y.branch || "main" }),
    });
    if (r.ok) { const sha = (await r.json()).content.sha; SHA.set(path, sha); return sha; }
    if (r.status === 409 && i < 3) { await new Promise((ok) => setTimeout(ok, 700 * (i + 1))); continue; }   // aynı anda başka kayıt yazıldı
    throw new Error("HTTP " + r.status);
  }
}
async function revGet(path) {
  const y = REV();
  const r = await fetch(revApi(y, path) + "?ref=" + encodeURIComponent(y.branch || "main"), { headers: revHeaders(y, true), cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return new Uint8Array(await r.arrayBuffer());
}
async function revDel(path) {
  const y = REV(), sha = SHA.get(path);
  if (!sha) throw new Error("sha yok");
  const r = await fetch(revApi(y, path), {
    method: "DELETE", headers: { ...revHeaders(y), "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Kayıt silindi", sha, branch: y.branch || "main" }),
  });
  if (!r.ok && r.status !== 404) throw new Error("HTTP " + r.status);
}

async function loadRevize() {
  const y = REV();
  if (!y || !S.dek) { S.revize = {}; return; }
  try {
    const r = await fetch(`${CFG.api}/repos/${y.repo}/git/trees/${y.branch || "main"}?recursive=1`, { headers: revHeaders(y), cache: "no-store" });
    if (!r.ok && r.status !== 404 && r.status !== 409) return;   // 404/409: depo boş
    const tree = r.ok ? (await r.json()).tree || [] : [];
    const m = {}, seen = new Set();
    const of = (cid) => (m[cid] ||= { dosyalar: [], notlar: [] });
    for (const t of tree) {
      if (t.type !== "blob") continue;
      seen.add(t.path); SHA.set(t.path, t.sha);
      if (SILINEN.has(t.path)) continue;
      let mm;
      if ((mm = t.path.match(/^([^/]+)\/(yorum|revize)\/(\d+)-[a-z0-9]+\.enc$/))) of(mm[1]).notlar.push({ path: t.path, tur: mm[2], ts: +mm[3] });
      else if ((mm = t.path.match(/^([^/]+)\/(\d+)-[a-z0-9]+\.enc$/))) of(mm[1]).dosyalar.push({ path: t.path, ts: +mm[2], eski: true });
    }
    const now = Date.now();
    for (const [path, b] of BEKLEYEN) {
      if (seen.has(path) || now - b.eklendi > 300000) BEKLEYEN.delete(path);
      else of(b.cid).notlar.push(b.kayit);
    }
    for (const [path, t] of SILINEN) if (!seen.has(path) || now - t > 300000) SILINEN.delete(path);
    S.revize = m;
    if (dlg.open) refreshItem();
  } catch { /* liste alınamadı; sonraki tazelemede tekrar denenir */ }
}

async function dosyaYukle(cid, file) {
  const head = new TextEncoder().encode(JSON.stringify({ ad: file.name, tip: file.type, boyut: file.size, tarih: new Date().toISOString(), yukleyen: benimAdim() }));
  const plain = new Uint8Array(4 + head.length + file.size);
  new DataView(plain.buffer).setUint32(0, head.length);
  plain.set(head, 4); plain.set(new Uint8Array(await file.arrayBuffer()), 4 + head.length);
  const path = `${cid}/ek/${Date.now()}-${rid()}.enc`;
  await revPut(path, await sifreleBayt(plain), "Revize eki");
  return path;
}
async function downloadRevize(path) {
  const plain = await cozBayt(await revGet(path));
  const n = new DataView(plain.buffer).getUint32(0);
  const head = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + n)));
  const url = URL.createObjectURL(new Blob([plain.subarray(4 + n)], { type: head.tip || "application/octet-stream" }));
  const a = h("a", { href: url, download: head.ad || "revize" });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return head;
}
async function notYaz(cid, tur, metin, sn, file) {
  const dosya = file ? { path: await dosyaYukle(cid, file), ad: file.name, boyut: file.size } : null;
  const kayit = { tur, metin, sn, yazan: benimAdim(), yazanId: S.myKeyId || "", tarih: new Date().toISOString(), dosya };
  const ts = Date.now(), path = `${cid}/${tur}/${ts}-${rid()}.enc`;
  await revPut(path, await sifreleBayt(new TextEncoder().encode(JSON.stringify(kayit))), tur === "revize" ? "Revize isteği" : "Yorum");
  NOTLAR.set(path, kayit);
  const n = { path, tur, ts };
  (S.revize[cid] ||= { dosyalar: [], notlar: [] }).notlar.push(n);
  BEKLEYEN.set(path, { cid, kayit: n, eklendi: Date.now() });
  if (tur === "revize") autoRevize();
}
async function notOku(path) {
  if (!NOTLAR.has(path)) NOTLAR.set(path, JSON.parse(new TextDecoder().decode(await cozBayt(await revGet(path)))));
  return NOTLAR.get(path);
}
async function notSil(cid, path, kayit) {
  await revDel(path);
  if (kayit && kayit.dosya && SHA.has(kayit.dosya.path)) revDel(kayit.dosya.path).catch(() => {});
  const e = S.revize[cid]; if (e) e.notlar = e.notlar.filter((x) => x.path !== path);
  BEKLEYEN.delete(path); SILINEN.set(path, Date.now());
}

const KABUL = ".pdf,.doc,.docx,.txt,.rtf,.odt,.pages,.md,.png,.jpg,.jpeg,.webp,application/pdf,text/plain,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*";

// Revizeler / Yorumlar sekmesi: kayıt listesi + yazma kutusu
function renderExtra(r) {
  const tur = S.tab === "yorum" ? "yorum" : "revize";
  $("#item-revplan").replaceChildren(...(tur === "revize" ? planList(r) : []));
  const box = $("#item-composer");
  const acik = REV() && S.dek, video = !!vimeoParse(r.vimeo);
  const yazilir = tur === "yorum" || VIDEOLU.has(etkin(r)) || video;
  if (acik && yazilir) {
    if (!box.firstChild || box.firstChild.dataset.tur !== tur || box.firstChild.dataset.cid !== r.id) box.replaceChildren(composer(r, tur, video));
  } else if (!acik && S.edit && yazilir) {
    // revize deposu ve yükleme anahtarı girilmemiş: kimse revize yazamaz, ne yapılacağı söylenir
    box.replaceChildren(h("div", { class: "note-box", id: "rev-kapali" }, "Revize ve yorum için kurulum gerekli: ",
      h("button", { class: "linkish", type: "button", text: "Erişim anahtarları", onclick: () => { dlg.close(); $("#btn-keys").click(); } }),
      " → Revize dosyası yükleme bölümü."));
  } else box.replaceChildren();
  renderThread();
}

function composer(r, tur, video) {
  let file = null;
  const ta = h("textarea", { id: "c-metin", rows: "3", "aria-label": tur === "revize" ? "Revize isteği" : "Yorum",
    placeholder: tur === "revize" ? "Neyin değişmesi gerekiyor? Ör. 12:40'taki slayt yanlış, bir sonrakiyle değişmeli." : "Yorumunu yaz…" });
  const stamp = video ? h("label", { class: "check stamp-check" }, h("input", { type: "checkbox", id: "c-stamp" }), h("span", { id: "c-stamp-t", text: "0:00 anına bağla" })) : null;
  const fileIn = h("input", { type: "file", class: "sr", id: "c-file", accept: KABUL });
  const fileBtn = tur === "revize" ? h("label", { class: "btn small file-btn" }, fileIn, "Dosya ekle") : null;
  const fileChip = h("span", { class: "file-chip", hidden: true });
  const send = h("button", { class: "btn pri small", type: "button", text: tur === "revize" ? "Revizeyi gönder" : "Gönder" });
  const status = h("p", { class: "form-err", role: "status" });
  const box = h("div", { class: "composer", "data-tur": tur, "data-cid": r.id },
    ta,
    h("div", { class: "composer-row" }, stamp, fileBtn, fileChip, h("span", { class: "sp" }), h("span", { class: "as-who", text: benimAdim() }), send),
    status);
  function setFile(f) {
    if (f && f.size > MAX_DOSYA) { status.style.color = ""; status.textContent = "Dosya 15 MB'tan büyük olamaz."; return; }
    file = f || null; fileIn.value = "";
    fileChip.hidden = !file;
    fileChip.replaceChildren(...(file ? [h("span", { text: file.name }), h("button", { type: "button", class: "linkish", "aria-label": "Dosyayı çıkar", text: "×", onclick: () => setFile(null) })] : []));
  }
  fileIn.addEventListener("change", () => setFile(fileIn.files[0]));
  if (tur === "revize") {
    box.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("over"); });
    box.addEventListener("dragleave", (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove("over"); });
    box.addEventListener("drop", (e) => { e.preventDefault(); box.classList.remove("over"); if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]); });
  }
  if (stamp) stamp.querySelector("input").addEventListener("change", (e) => { e.target.dataset.elle = "1"; });
  ta.addEventListener("focus", () => { if (P.player) P.player.pause().catch(() => {}); });   // yazarken video dursun, an kaymasın
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send.click(); } });
  send.addEventListener("click", async () => {
    const metin = ta.value.trim();
    status.style.color = "";
    if (!metin && !file) { status.textContent = tur === "revize" ? "Revize isteğini yaz ya da dosya ekle." : "Yorumunu yaz."; ta.focus(); return; }
    const chk = $("#c-stamp");
    const sn = chk && chk.checked ? Math.round(P.t * 10) / 10 : null;
    send.disabled = true; status.style.color = "var(--muted)"; status.textContent = file ? `“${file.name}” yükleniyor…` : "Gönderiliyor…";
    try {
      await notYaz(r.id, tur, metin, sn, file);
      ta.value = ""; setFile(null);
      status.style.color = "var(--ok)"; status.textContent = tur === "revize" ? "Revize isteğin iletildi." : "Yorumun eklendi.";
      render(); refreshItem();
    } catch {
      status.style.color = ""; status.textContent = "Gönderilemedi. İnternet bağlantını kontrol edip tekrar dene.";
    } finally { send.disabled = false; }
  });
  setTimeout(stampLabel, 0);
  return box;
}
function refreshTabsCount(r) {
  $("#tab-rev-n").textContent = revlerOf(r).length ? String(revlerOf(r).length) : "";
  $("#tab-yor-n").textContent = yorumlarOf(r).length ? String(yorumlarOf(r).length) : "";
}

function renderThread() {
  const ul = $("#thread"), r = S.current && S.data.cekimler.find((x) => x.id === S.current);
  if (!ul || !r) return;
  const tur = S.tab === "yorum" ? "yorum" : "revize";
  const items = (tur === "yorum" ? yorumlarOf(r) : revlerOf(r)).slice().sort((a, b) => b.ts - a.ts);
  if (!items.length) {
    ul.replaceChildren(h("li", { class: "thread-empty", text: tur === "yorum" ? "Henüz yorum yok." : VIDEOLU.has(etkin(r)) ? "Henüz revize isteği yok." : "Montaj bitince revize istekleri burada görünecek." }));
    return;
  }
  ul.replaceChildren(...items.map((it) => notEl(r, it)));
}
function notEl(r, it) {
  const li = h("li", { class: "note" + (it.eski || it.tur === "revize" ? " revize" : "") });
  if (it.eski) { fillNote(li, r, it, { tur: "revize", metin: "", yazan: "", tarih: new Date(it.ts).toISOString(), dosya: { path: it.path, ad: "Revizyon dosyası" } }); return li; }
  const k = NOTLAR.get(it.path);
  if (k) fillNote(li, r, it, k);
  else {
    li.append(h("div", { class: "skel line" }));
    notOku(it.path).then((k2) => { li.replaceChildren(); fillNote(li, r, it, k2); renderRail(); })
      .catch(() => li.replaceChildren(h("span", { class: "muted", text: "Bu kayıt okunamadı." })));
  }
  return li;
}
function fillNote(li, r, it, k) {
  const ad = k.yazan || (it.eski ? "Yüklenen dosya" : "İsimsiz");
  const silebilir = !it.eski && (S.edit || (k.yazanId && k.yazanId === S.myKeyId));
  const head = h("div", { class: "note-head" }, h("b", { text: ad }),
    h("time", { datetime: k.tarih, title: fmtSaat(Date.parse(k.tarih) || it.ts), text: fmtGoreli(k.tarih) }));
  if (silebilir) {
    const del = h("button", { class: "linkish note-del", type: "button", text: "Sil" });
    del.addEventListener("click", async () => {
      if (!del.dataset.onay) { del.dataset.onay = "1"; del.textContent = "Silinsin mi? Evet"; return; }
      del.disabled = true;
      try { await notSil(r.id, it.path, k); render(); refreshItem(); }
      catch { del.disabled = false; del.textContent = "Silinemedi"; }
    });
    head.append(del);
  }
  const body = h("div", { class: "note-body" }, head,
    Number.isFinite(k.sn) ? h("button", { class: "tc", type: "button", title: "Videoda bu ana git", text: fmtTc(k.sn), onclick: () => { seek(k.sn); markRail(it.path); } }) : null,
    k.metin ? h("div", { class: "note-text", text: k.metin }) : null,
    k.dosya ? fileRow(k.dosya, it.eski) : null);
  li.append(it.eski ? h("span", { class: "av", style: avStyle("dosya"), "aria-hidden": "true", text: "↥" }) : av(ad), body);
}
function fileRow(d, eski) {
  const name = h("span", { text: d.ad + (d.boyut ? ` · ${Math.max(1, Math.round(d.boyut / 1024))} KB` : "") });
  const btn = h("button", { class: "btn small", type: "button", text: "İndir" });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try { const hd = await downloadRevize(d.path); if (eski) name.textContent = hd.ad + (hd.yukleyen ? " · " + hd.yukleyen : ""); }
    catch { btn.textContent = "İndirilemedi"; }
    finally { btn.disabled = false; }
  });
  return h("div", { class: "note-file" }, name, btn);
}

// yönetici: revize yükleme ayarı
$("#btn-rev-save").addEventListener("click", async () => {
  const repo = $("#f-rev-repo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
  const token = $("#f-rev-token").value.trim();
  const out = $("#rev-msg"); out.style.color = ""; out.textContent = "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { out.textContent = "Depoyu kullanıcı/depo biçiminde yaz (ör. MonarkCo/Trigemy-revize)."; return; }
  if (!token && !REV()) { out.textContent = "Yükleme anahtarını gir."; return; }
  const tok = token || REV().token;
  $("#btn-rev-save").disabled = true;
  try {
    const r = await fetch(`${CFG.api}/repos/${repo}`, { headers: { Authorization: "Bearer " + tok, Accept: "application/vnd.github+json" } });
    if (!r.ok) throw new Error("Bu anahtar depoyu göremiyor.");
    const j = await r.json();
    if (j.permissions && !j.permissions.push) throw new Error("Bu anahtarın depoya yazma izni yok.");
    if (repo.toLowerCase() === `${CFG.owner}/${CFG.repo}`.toLowerCase()) throw new Error("Ana pano deposunu değil, ayrı bir revize deposunu kullan.");
    mutate(() => { S.data.yukleme = { repo, token: tok, branch: j.default_branch || "main" }; }, "Revize yükleme ayarı güncellendi");
    $("#f-rev-token").value = "";
    out.style.color = "var(--ok)"; out.textContent = `Ayarlandı: ${repo}`;
    loadRevize().then(render);
  } catch (e) { out.textContent = e.message || "Ayarlanamadı."; }
  finally { $("#btn-rev-save").disabled = false; }
});
function renderRevSettings() {
  const y = REV();
  $("#f-rev-repo").value = y ? y.repo : `${CFG.owner}/${CFG.repo}-revize`;
  $("#f-rev-token").placeholder = y ? "Ayarlı (değiştirmek için yenisini gir)" : "github_pat_…";
  $("#rev-msg").style.color = y ? "var(--ok)" : "";
  $("#rev-msg").textContent = y ? `Açık: revizeler ${y.repo} deposuna yazılıyor.` : "Henüz ayarlanmadı: hocalar revize yazamaz.";
}

/* ---------- araç çubuğu ---------- */
for (const b of document.querySelectorAll("[data-view]")) b.addEventListener("click", () => { S.view = b.dataset.view; store.set("trigemy_view", S.view); render(); });
// Türkçe / yabancı dil sekmesi; linke #yabanci eklenirse doğrudan o sekme açılır
for (const b of document.querySelectorAll("[data-sekme]")) b.addEventListener("click", () => {
  S.sekme = b.dataset.sekme; store.set("trigemy_sekme", S.sekme);
  try { history.replaceState(null, "", S.sekme === "yabanci" ? "#yabanci" : location.pathname + location.search); } catch {}
  render();
});
for (const b of document.querySelectorAll("[data-tur]")) b.addEventListener("click", () => {
  S.tur = b.dataset.tur;
  for (const x of document.querySelectorAll("[data-tur]")) x.setAttribute("aria-pressed", String(x === b));
  render();
});
let qt; $("#q").addEventListener("input", (e) => { clearTimeout(qt); qt = setTimeout(() => { S.q = trLower(e.target.value.trim()); render(); }, 120); });
$("#btn-add").addEventListener("click", () => openItem(null));
$("#btn-theme").addEventListener("click", () => {
  const root = document.documentElement;
  const koyu = root.dataset.theme ? root.dataset.theme === "dark" : !matchMedia("(prefers-color-scheme: light)").matches;
  root.dataset.theme = koyu ? "light" : "dark";
  store.set("trigemy_tema", root.dataset.theme);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) && !document.querySelector("dialog[open]")) { e.preventDefault(); $("#q").focus(); }
});
addEventListener("beforeunload", (e) => { if (S.dirty || S.saving || S.ozelDirty) { e.preventDefault(); e.returnValue = ""; } });

// arada bir tazele; düzenleyen kişi de ekibin değişikliklerini görsün (kaydedilmemiş değişiklik ya da açık pencere yokken)
const tazelenir = () => !document.hidden && S.loaded && $("#lock").hidden && !S.dirty && !S.saving && !document.querySelector("dialog[open]");
setInterval(() => { if (tazelenir()) load({ quiet: true }); }, 180000);
// bir videonun üzerinde çalışılırken izleyenler adımı (Renderlanıyor…) daha sık görsün
setInterval(() => { if (tazelenir() && S.data.cekimler.some(isOf)) load({ quiet: true }); }, 45000);
setInterval(renderLive, 60000);
document.addEventListener("visibilitychange", () => { if (tazelenir()) load({ quiet: true }); });

showMain();
render();
load();
