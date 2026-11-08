"use strict";
/* Trigemy · Montaj Takibi
   Veri: depodaki data.json. Herkes okur; düzenleme modunda GitHub anahtarıyla aynı dosyaya commit atılır. */

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

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const CFG = Object.assign({ owner: "", repo: "", branch: "main", path: "data.json" }, window.TRIGEMY || {});
if (!CFG.owner && location.hostname.endsWith(".github.io")) {
  CFG.owner = location.hostname.split(".")[0];
  CFG.repo = location.pathname.split("/").filter(Boolean)[0] || CFG.owner + ".github.io";
}
const API = CFG.owner && CFG.repo ? `https://api.github.com/repos/${CFG.owner}/${CFG.repo}/contents/${CFG.path}` : "";
const TOKEN_KEY = "trigemy_gh_token";
const KEY_KEY = "trigemy_pano_anahtar";

const S = {
  data: { cekimler: [] }, sha: null, loaded: false,
  token: store.get(TOKEN_KEY), edit: false,
  view: store.get("trigemy_view") || (matchMedia("(max-width: 680px)").matches ? "liste" : "pano"),
  sekme: location.hash === "#yabanci" ? "yabanci" : location.hash === "#turkce" ? "tr" : store.get("trigemy_sekme") || "tr",
  tur: "", q: "", current: null, saveTimer: null, saving: false, dirty: false,
  dek: null, enc: false, lastDoc: null, anahtarlar: [], myKeyId: null, revize: {},   // dek: çözülmüş veri anahtarı
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
// dil boşsa Türkçe; yabancı dil konuşan hocalar ayrı sekmede
const yabanci = (r) => !!r.dil && trLower(r.dil) !== "türkçe";
const sekmede = (r) => yabanci(r) === (S.sekme === "yabanci");
const cekimAdi = (r) => r.ad || (r.tur === "Ofis" ? "Ofis Çekimi" : r.tur + " Çekim");
const b64enc = (str) => { const b = new TextEncoder().encode(str); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const b64dec = (b64) => new TextDecoder().decode(b64bytes(b64));
const b64bytes = (b64) => Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0));
const bytesb64 = (b) => { let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };

/* ---------- şifreleme ----------
   Veri rastgele bir veri anahtarıyla (AES-GCM) şifreli. Her erişim anahtarı bu veri anahtarını ayrı ayrı sarar;
   anahtar silinince onun sargısı da silinir, o kişi bir daha açamaz. Biçim sifrele.mjs ile aynı. */
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
        if (u) { S.dek = u.dek; S.myKeyId = u.id; plain = await decryptDoc(doc, S.dek); }
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
    loadRevize().then(render);
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

/* ---------- görünüm ---------- */
function banner(text, color) {
  const b = $("#banner");
  b.textContent = text || ""; b.hidden = !text;
  if (color) b.style.setProperty("--c", cssVar(color));
}
function syncChip(text, color) {
  const s = $("#sync");
  if (!S.edit) { s.hidden = true; return; }
  s.hidden = false; s.textContent = text; s.style.setProperty("--c", color);
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
  const sayi = Object.fromEntries(DURUMLAR.map((d) => [d.id, all.filter((r) => r.durum === d.id).length]));
  const biten = all.filter((r) => BITEN.has(r.durum)).length;
  const pct = n ? Math.round((biten / n) * 100) : 0;

  // genel durum
  $("#pct").textContent = pct + "%";
  $("#ring-val").style.strokeDashoffset = String(326.73 * (1 - (n ? biten / n : 0)));
  $("#ring").setAttribute("aria-label", `Tamamlanma oranı yüzde ${pct}`);
  $("#done-line").textContent = S.loaded ? (n ? `${n} çekimden ${biten} tanesinin montajı tamamlandı` : S.sekme === "yabanci" ? "Henüz yabancı dil çekimi eklenmedi" : "Henüz çekim eklenmedi") : "—";
  const aktif = sayi.montajda + sayi.revize;
  $("#sub-line").textContent = !S.loaded ? "Veriler yükleniyor…" :
    aktif ? `Şu an ${aktif} çekim üzerinde çalışılıyor, ${sayi.bekliyor} çekim sırada.` : `${sayi.bekliyor} çekim montaj sırasında bekliyor.`;
  $("#stack").replaceChildren(...DURUMLAR.filter((d) => sayi[d.id]).map((d) => h("i", { style: `--c:${cssVar(d.renk)};flex-grow:${sayi[d.id]}`, title: `${d.ad}: ${sayi[d.id]}` })));
  $("#legend").replaceChildren(...DURUMLAR.map((d) => h("li", { style: `--c:${cssVar(d.renk)}` }, d.ad + " ", h("b", { text: String(sayi[d.id]) }))));

  const kpi = (label, val, color, note) => h("div", { class: "kpi", style: `--c:${cssVar(color)}` }, h("span", { text: label }), h("b", { text: String(val) }), note ? h("small", { text: note }) : null);
  const egitmen = new Set(all.map((r) => trLower(r.egitmen))).size;
  $("#kpis").replaceChildren(
    kpi("Toplam çekim", n, "--brand", `${egitmen} eğitmen`),
    kpi("Montajda", sayi.montajda, "--st-montajda", "şu an kurguda"),
    kpi("Revizede", sayi.revize, "--st-revize", "geri bildirim işleniyor"),
    kpi("Tamamlanan", biten, "--st-montajlandi", sayi.yayinda ? `${sayi.yayinda} tanesi yayında` : "montajı biten"),
  );

  const upd = S.data.guncelleme;
  $("#foot-upd").textContent = upd ? "Son güncelleme: " + fmtGun(upd) + " · " + fmtGoreli(upd) : "";

  // görünümler
  $("#view-pano").hidden = S.view !== "pano";
  $("#view-liste").hidden = S.view !== "liste";
  for (const b of document.querySelectorAll("[data-view]")) b.setAttribute("aria-pressed", String(b.dataset.view === S.view));
  $("#btn-add").hidden = !S.edit;
  $("#btn-keys").hidden = !(S.edit && S.enc);
  $("#btn-forget").hidden = !S.enc;
  $("#btn-mode").textContent = S.edit ? "Düzenlemeyi kapat" : "Düzenle";

  const rows = all.filter(visible).sort(bySira);
  if (S.view === "pano") renderBoard(rows); else renderTable(rows);
}

function renderBoard(rows) {
  const board = $("#board");
  board.replaceChildren(...DURUMLAR.map((d) => {
    const items = rows.filter((r) => r.durum === d.id);
    const col = h("section", { class: "col", style: `--c:${cssVar(d.renk)}`, "aria-label": d.ad },
      h("div", { class: "col-head" }, h("span", { class: "col-dot" }), h("h3", { text: d.ad }), h("span", { class: "col-count", text: String(items.length) })),
      !S.loaded ? [h("div", { class: "skel" }), h("div", { class: "skel" })] :
      items.length ? items.map(card) : h("div", { class: "col-empty", text: S.edit ? "Kartı buraya sürükle" : "Bu aşamada çekim yok" }),
    );
    if (S.edit) {
      col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("over"); });
      col.addEventListener("dragleave", (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove("over"); });
      col.addEventListener("drop", (e) => { e.preventDefault(); col.classList.remove("over"); setDurum(e.dataTransfer.getData("text/plain"), d.id); });
    }
    return col;
  }));
}

function card(r) {
  const d = durumOf(r.durum);
  const sel = S.edit ? h("select", { "aria-label": "Durumu değiştir", onclick: (e) => e.stopPropagation(), onchange: (e) => setDurum(r.id, e.target.value) },
    DURUMLAR.map((x) => h("option", { value: x.id, selected: x.id === r.durum, text: x.ad }))) : null;
  const v = vimeoParse(r.vimeo);
  const c = h("article", { class: "card", tabindex: "0", draggable: S.edit ? "true" : null, style: `--c:${cssVar(d.renk)}`, "aria-label": `${r.egitmen}, ${cekimAdi(r)}, ${d.ad}` },
    v ? vimeoThumb(r, v) : S.edit && VIDEOLU.has(r.durum) ? vimeoPaste(r) : null,
    h("div", { class: "card-top" }, h("div", { class: "card-name", text: r.egitmen || "İsimsiz" }), r.sira ? h("span", { class: "card-no", text: "#" + r.sira }) : null),
    h("div", { class: "chips" },
      yabanci(r) ? h("span", { class: "chip lang", text: r.dil }) : null,
      h("span", { class: "chip " + r.tur, text: cekimAdi(r) }),
      r.disk ? h("span", { class: "chip warn", text: "Medya başka diskte" }) : null,
      r.teslim ? h("span", { class: "chip date", text: "Teslim " + fmtKisa(r.teslim) }) : null),
    r.not ? h("div", { class: "card-note", text: r.not }) : null,
    revizeChip(r),
    VIDEOLU.has(r.durum) || v || safeUrl(r.link) ? h("div", { class: "card-acts" },
      safeUrl(r.link) ? h("a", { class: "btn small primary", href: safeUrl(r.link), target: "_blank", rel: "noopener noreferrer", text: "Videoyu indir", onclick: (e) => e.stopPropagation() }) : null,
      // montajı biten her kartta (yükleme ayarı yoksa pencere ne yapılacağını söyler)
      VIDEOLU.has(r.durum) || v ? h("button", { class: "btn small", type: "button", text: "Revize ekle", onclick: (e) => { e.stopPropagation(); openItem(r.id, { upload: true, revize: true }); } }) : null) : null,
    h("div", { class: "card-foot" }, h("span", { text: fmtGoreli(r.guncelleme) }), sel),
  );
  c.addEventListener("click", () => openItem(r.id));
  c.addEventListener("keydown", (e) => { if (e.target === c && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openItem(r.id); } });
  if (S.edit) {
    c.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", r.id); e.dataTransfer.effectAllowed = "move"; c.classList.add("dragging"); });
    c.addEventListener("dragend", () => c.classList.remove("dragging"));
  }
  return c;
}

function renderTable(rows) {
  const tb = $("#rows");
  if (!S.loaded) { tb.replaceChildren(h("tr", null, h("td", { colspan: "7" }, h("div", { class: "skel" })))); return; }
  if (!rows.length) { tb.replaceChildren(h("tr", null, h("td", { colspan: "7", class: "note", text: "Aramaya uyan çekim yok." }))); return; }
  tb.replaceChildren(...rows.map((r) => {
    const d = durumOf(r.durum);
    const tr = h("tr", { tabindex: "0" },
      h("td", { class: "num", text: r.sira ? "#" + r.sira : "—" }),
      h("td", { class: "name", text: r.egitmen }),
      h("td", null, yabanci(r) ? [h("span", { class: "chip lang", text: r.dil }), " "] : null, h("span", { class: "chip " + r.tur, text: cekimAdi(r) }), r.disk ? [" ", h("span", { class: "chip warn", text: "Başka diskte" })] : null),
      h("td", null, h("span", { class: "pill", style: `--c:${cssVar(d.renk)}`, text: d.ad })),
      h("td", { "data-k": r.teslim ? "Teslim" : null, text: r.teslim ? fmtKisa(r.teslim) : "" }),
      h("td", { "data-k": "Güncelleme", text: fmtGoreli(r.guncelleme) }),
      h("td", { class: "note", text: r.not || "" }),
    );
    tr.addEventListener("click", () => openItem(r.id));
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter") openItem(r.id); });
    return tr;
  }));
}

function setDurum(id, durum) {
  const r = S.data.cekimler.find((x) => x.id === id);
  if (!r || r.durum === durum || !S.edit) return;
  mutate(() => {
    const now = new Date().toISOString();
    r.durum = durum; r.guncelleme = now; r.gecmis.push({ durum, tarih: now });
  }, `${r.egitmen} (${cekimAdi(r)}) → ${durumOf(durum).ad}`);
  if (VIDEOLU.has(durum) && !r.vimeo) openItem(id, { focus: "#f-vimeo" });   // montajlanan videonun Vimeo linki
}

/* ---------- ayrıntı / düzenleme penceresi ---------- */
const dlg = $("#dlg-item");
for (const d of DURUMLAR) $("#f-durum").append(h("option", { value: d.id, text: d.ad }));

function openItem(id, opts = {}) {
  const r = id ? S.data.cekimler.find((x) => x.id === id) : null;
  S.current = r ? r.id : null;
  const d = durumOf(r ? r.durum : "bekliyor");
  $("#item-eyebrow").textContent = r ? (yabanci(r) ? r.dil + " · " : "") + cekimAdi(r) : "Yeni kayıt";
  $("#item-title").textContent = r ? r.egitmen : "Yeni çekim";

  // görüntüleme
  const view = $("#item-view");
  if (r) {
    view.replaceChildren(...[
      h("div", { class: "facts" },
        fact("Durum", h("span", { class: "pill", style: `--c:${cssVar(d.renk)}`, text: d.ad })),
        fact("Çekim", cekimAdi(r)),
        fact("Sıra", r.sira ? "#" + r.sira : "—"),
        fact("Teslim", r.teslim ? fmtGun(r.teslim) : "—")),
      r.disk ? h("div", { class: "note-box", style: "border-left:3px solid var(--danger)", text: "Bu çekimin medyası başka bir diskte." }) : null,
      r.not ? [h("p", { class: "sec-title", text: "Not" }), h("div", { class: "note-box", text: r.not })] : null,
      r.gecmis.length ? [h("p", { class: "sec-title", text: "Süreç" }),
        h("ol", { class: "timeline" }, [...r.gecmis].reverse().map((g) => h("li", { style: `--c:${cssVar(durumOf(g.durum).renk)}` }, h("span", { text: durumOf(g.durum).ad }), h("time", { datetime: g.tarih, text: fmtGun(g.tarih) }))))] : null,
    ].flat().filter(Boolean));
  }
  // düzenleme
  $("#f-egitmen").value = r?.egitmen || "";
  $("#f-tur").value = r?.tur || "Teorik";
  $("#f-durum").value = r?.durum || "bekliyor";
  $("#f-sira").value = r?.sira ?? "";
  $("#f-teslim").value = r?.teslim || "";
  $("#f-ad").value = r?.ad || "";
  $("#f-dil").value = r ? r.dil || "Türkçe" : S.sekme === "yabanci" ? "İngilizce" : "Türkçe";
  $("#f-disk").checked = !!r?.disk;
  $("#f-not").value = r?.not || "";
  $("#f-link").value = r?.link || "";
  $("#f-vimeo").value = r?.vimeo || "";
  $("#f-err").textContent = "";
  vimeoHint();
  showMedia(r ? vimeoParse(r.vimeo) : null, opts);
  renderExtra(r, opts);

  const editing = S.edit;
  view.hidden = editing || !r;
  $("#item-edit").hidden = !editing;
  $("#item-foot").hidden = !editing;
  $("#btn-del").hidden = !r; $("#del-confirm").hidden = true;
  dlg.showModal();
  if (editing && !r) $("#f-egitmen").focus();
  if (editing && opts.focus) $(opts.focus).focus();
  if (opts.upload && $("#c-metin")) setTimeout(() => { $("#c-metin").scrollIntoView({ block: "nearest" }); $("#c-metin").focus(); }, 60);
  else if (opts.upload && $("#rev-kapali")) setTimeout(() => $("#rev-kapali").scrollIntoView({ block: "nearest" }), 60);
}
// pencere hangi yoldan kapanırsa kapansın (çarpı, Esc, kaydet) video da durur; close olayı arka plandaki sekmede gecikebiliyor
new MutationObserver(() => { if (!dlg.open) stopMedia(); }).observe(dlg, { attributes: true, attributeFilter: ["open"] });
function fact(label, val) { return h("div", { class: "fact" }, h("span", { text: label }), typeof val === "string" ? h("b", { text: val }) : val); }

$("#item-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!S.edit) return dlg.close();
  const egitmen = $("#f-egitmen").value.trim();
  if (!egitmen) { $("#f-err").textContent = "Eğitmen adını yaz."; return; }
  const sira = parseInt($("#f-sira").value, 10);
  const val = {
    egitmen, tur: $("#f-tur").value, durum: $("#f-durum").value, sira: Number.isFinite(sira) ? sira : null,
    teslim: $("#f-teslim").value, ad: $("#f-ad").value.trim(), dil: trLower($("#f-dil").value.trim()) === "türkçe" ? "" : $("#f-dil").value.trim(), disk: $("#f-disk").checked, not: $("#f-not").value.trim(),
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
      if (r.durum !== val.durum) r.gecmis.push({ durum: val.durum, tarih: now });
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

/* ---------- düzenleme modu ---------- */
const authDlg = $("#dlg-auth");
$("#btn-mode").addEventListener("click", () => {
  if (S.edit) { S.edit = false; syncChip(); render(); return; }
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
    const r = await fetch(`https://api.github.com/repos/${CFG.owner}/${CFG.repo}`, { headers: { Authorization: "Bearer " + tok, Accept: "application/vnd.github+json" } });
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
}
function logout(msg) {
  S.token = null; S.edit = false; store.set(TOKEN_KEY, null);
  syncChip(); render();
  if (msg) banner(msg, "--danger");
}

/* ---------- kilit ve erişim anahtarları ---------- */
function showLock() {
  S.edit = false; syncChip();
  $("#main").hidden = true; $("#lock").hidden = false; $("#btn-mode").hidden = true; $(".mast-tabs").hidden = true;
  $("#lock-pass").value = ""; $("#lock-err").textContent = "";
  $("#lock-pass").focus();
}
function showMain() { $("#lock").hidden = true; $("#main").hidden = false; $("#btn-mode").hidden = false; $(".mast-tabs").hidden = false; }
$("#lock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = $("#lock-pass").value;
  if (!key || !S.lastDoc) return;
  $("#lock-btn").disabled = true; $("#lock-err").textContent = "";
  try {
    const u = await unwrapDek(S.lastDoc, key);
    if (!u) throw new Error("yanlış");
    const plain = await decryptDoc(S.lastDoc, u.dek);
    S.dek = u.dek; S.myKeyId = u.id; S.enc = true;
    if ($("#lock-remember").checked) store.set(KEY_KEY, normKey(key));
    setData(plain, S.lastDoc.anahtarlar); S.loaded = true;
    showMain(); banner(""); render();
    loadRevize().then(render);
  } catch { $("#lock-err").textContent = "Anahtar geçersiz."; $("#lock-pass").select(); }
  finally { $("#lock-btn").disabled = false; }
});
$("#btn-forget").addEventListener("click", () => {
  store.set(KEY_KEY, null); S.dek = null; S.data = { cekimler: [] };
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
      renderKeys();
    });
    return h("li", { class: "key-row" },
      h("div", { class: "key-info" }, h("b", { text: k.ad || "İsimsiz" }), mine ? h("span", { class: "chip", style: "--c:var(--brand)", text: "Bu cihaz" }) : null,
        h("small", { text: "Oluşturma: " + fmtGun(k.olusturma) })),
      h("div", { class: "key-actions" }, del, yes));
  }));
  $("#key-count").textContent = list.length + " anahtar";
}
$("#btn-keys").addEventListener("click", () => {
  $("#key-new").hidden = true; $("#f-keyname").value = ""; $("#key-err").textContent = "";
  renderKeys(); renderRevSettings(); keysDlg.showModal();
});
$("#key-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const ad = $("#f-keyname").value.trim();
  if (!ad) { $("#key-err").textContent = "Anahtarın kimin için olduğunu yaz."; return; }
  if (!S.dek) return;
  $("#btn-keygen").disabled = true; $("#key-err").textContent = "";
  try {
    const key = yeniAnahtar(), id = uid();
    const entry = await wrapEntry(id, key, S.dek);
    mutate(() => {
      S.anahtarlar.push(entry);
      (S.data.erisim ||= []).push({ id, ad, olusturma: new Date().toISOString() });
    }, `Erişim anahtarı eklendi: ${ad}`);
    $("#key-value").textContent = key;
    $("#key-for").textContent = ad;
    $("#key-new").hidden = false; $("#f-keyname").value = "";
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

function vimeoThumb(r, v) {
  const dur = h("span", { class: "thumb-dur" });
  const b = h("button", { class: "thumb", type: "button", "aria-label": `${r.egitmen} videosunu izle`,
    onclick: (e) => { e.stopPropagation(); openItem(r.id, { play: true }); } }, h("span", { class: "thumb-play", "aria-hidden": "true" }), dur);
  vimeoInfo(v).then((d) => {
    const t = thumbUrl(d); if (t) b.style.backgroundImage = `url("${t}")`;
    if (d && d.duration) dur.textContent = fmtSure(d.duration);
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

// pencerede oynatıcı; zaman kodu için Vimeo'nun oynatıcı kütüphanesi yalnız gerektiğinde yüklenir
const P = { el: null, embed: "", player: null, t: 0, sdk: null };
function loadSdk() {
  if (window.Vimeo && window.Vimeo.Player) return Promise.resolve();
  return (P.sdk ||= new Promise((res, rej) => document.head.append(h("script", { src: VIMEO_SDK, onload: res, onerror: () => { P.sdk = null; rej(); } }))));
}
function showMedia(v, opts = {}) {
  dlg.classList.toggle("wide", !!v);
  if (!v) { stopMedia(); return; }
  if (P.embed === v.embed && P.el && P.el.isConnected) return;   // aynı video zaten açık
  stopMedia();
  const ifr = h("iframe", { src: v.embed + (opts.play ? "&autoplay=1" : ""), title: "Vimeo videosu", allowfullscreen: true,
    allow: "autoplay; fullscreen; picture-in-picture; clipboard-write", referrerpolicy: "strict-origin-when-cross-origin" });
  const title = h("span", { class: "media-title", text: "Vimeo" });
  const box = $("#item-media");
  box.replaceChildren(h("div", { class: "player" }, ifr),
    h("div", { class: "media-meta" }, title, h("a", { href: v.url, target: "_blank", rel: "noopener noreferrer", text: "Vimeo'da aç ↗" })));
  box.hidden = false;
  P.el = ifr; P.embed = v.embed; P.t = 0;
  vimeoInfo(v).then((d) => { if (d && d.title && P.el === ifr) title.textContent = d.title + (d.duration ? " · " + fmtSure(d.duration) : ""); });
  loadSdk().then(() => {
    if (P.el !== ifr) return;
    const p = new window.Vimeo.Player(ifr);
    P.player = p;
    p.on("timeupdate", (d) => { P.t = d.seconds; stampLabel(); });
    p.on("seeked", (d) => { P.t = d.seconds; stampLabel(); });
  }).catch(() => {});
}
function stopMedia() {
  if (P.player) { try { P.player.destroy(); } catch {} }
  P.el = null; P.embed = ""; P.player = null; P.t = 0;
  const box = $("#item-media"); box.replaceChildren(); box.hidden = true;
}
function seek(sn) {
  if (!P.player) return;
  $("#item-media").scrollIntoView({ block: "nearest", behavior: "smooth" });
  P.player.setCurrentTime(sn).then(() => P.player.play()).catch(() => {});
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
const revApi = (y, path = "") => `https://api.github.com/repos/${y.repo}/contents/${path}`;
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
    const r = await fetch(`https://api.github.com/repos/${y.repo}/git/trees/${y.branch || "main"}?recursive=1`, { headers: revHeaders(y), cache: "no-store" });
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
      else if ((mm = t.path.match(/^([^/]+)\/(\d+)-[a-z0-9]+\.enc$/))) of(mm[1]).dosyalar.push({ path: t.path, ts: +mm[2] });
    }
    const now = Date.now();
    for (const [path, b] of BEKLEYEN) {
      if (seen.has(path) || now - b.eklendi > 300000) BEKLEYEN.delete(path);
      else of(b.cid).notlar.push(b.kayit);
    }
    for (const [path, t] of SILINEN) if (!seen.has(path) || now - t > 300000) SILINEN.delete(path);
    S.revize = m;
    if (dlg.open) renderThread();
  } catch { /* liste alınamadı; sonraki tazelemede tekrar denenir */ }
}
function revizeChip(r) {
  const e = revOf(r.id);
  const revler = [...e.dosyalar, ...e.notlar.filter((n) => n.tur === "revize")], yorumlar = e.notlar.filter((n) => n.tur === "yorum");
  if (!revler.length && !yorumlar.length) return null;
  const son = Date.parse(r.guncelleme || 0) || 0;
  const yeniRev = revler.some((x) => x.ts > son), yeniYor = yorumlar.some((x) => x.ts > son);
  return h("div", { class: "chips" },
    revler.length ? h("span", { class: "chip", style: `--c:var(${yeniRev ? "--st-revize" : "--brand"})`, text: (yeniRev ? "Yeni revize · " : "") + revler.length + " revize" }) : null,
    yorumlar.length ? h("span", { class: "chip", style: `--c:var(${yeniYor ? "--st-montajda" : "--muted"})`, text: (yeniYor ? "Yeni yorum · " : "") + yorumlar.length + " yorum" }) : null);
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

const AVATAR = ["--st-montajda", "--st-montajlandi", "--st-yayinda", "--st-revize", "--brand"];
const avatarRenk = (s) => { let x = 0; for (const c of s || "") x = (x * 31 + c.charCodeAt(0)) >>> 0; return AVATAR[x % AVATAR.length]; };
const basHarf = (s) => (s || "?").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toLocaleUpperCase("tr");
const KABUL = ".pdf,.doc,.docx,.txt,.rtf,.odt,.pages,.md,.png,.jpg,.jpeg,.webp,application/pdf,text/plain,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*";

function renderExtra(r, opts = {}) {
  const box = $("#item-extra");
  if (!r) { box.replaceChildren(); box.hidden = true; return; }
  const link = safeUrl(r.link), video = !!vimeoParse(r.vimeo);
  const acik = REV() && S.dek;
  const parts = [];
  if (link) parts.push(h("a", { class: "btn dl", href: link, target: "_blank", rel: "noopener noreferrer" }, h("svg", { viewBox: "0 0 20 20", "aria-hidden": "true" }), "Videoyu indir"));
  if (acik) {
    parts.push(h("p", { class: "sec-title", id: "thread-title", text: "Yorumlar ve revizeler" }), h("ul", { class: "thread", id: "thread" }));
    parts.push(composer(r, video || VIDEOLU.has(r.durum), video, opts));
  } else if (S.edit || video || VIDEOLU.has(r.durum)) {
    // revize deposu ve yükleme anahtarı girilmemiş: kimse revize yazamaz, ne yapılacağı söylenir
    parts.push(h("p", { class: "sec-title", text: "Revize ekle" }), h("div", { class: "note-box", id: "rev-kapali" },
      S.edit && S.enc ? ["Revize ve yorum için kurulum gerekli: ",
        h("button", { class: "linkish", type: "button", text: "Erişim anahtarları", onclick: () => { dlg.close(); $("#btn-keys").click(); } }),
        " → en alttaki Revize dosyası yükleme bölümüne revize deposunu ve yükleme anahtarını gir."]
      : "Revize ekleme henüz açılmadı. Pano yöneticisi kurulumu tamamlayınca revizeni buradan yazabileceksin."));
  }
  box.replaceChildren(...parts);
  const svg = box.querySelector(".dl svg");
  if (svg) svg.innerHTML = '<path d="M10 3v10m0 0-4-4m4 4 4-4M4 16h12"/>';
  box.hidden = !parts.length;
  renderThread();
}

function composer(r, revizeOlur, video, opts) {
  let tur = "yorum", file = null;
  const ta = h("textarea", { id: "c-metin", rows: "3", "aria-label": "Yorum" });
  const kinds = revizeOlur ? h("div", { class: "seg", role: "group", "aria-label": "Kayıt türü" },
    h("button", { type: "button", "data-kind": "yorum", text: "Yorum" }),
    h("button", { type: "button", "data-kind": "revize", text: "Revize isteği" })) : null;
  const stamp = video ? h("label", { class: "check stamp-check" }, h("input", { type: "checkbox", id: "c-stamp" }), h("span", { id: "c-stamp-t", text: "0:00 anına bağla" })) : null;
  const fileIn = h("input", { type: "file", class: "sr", id: "c-file", accept: KABUL });
  const fileBtn = h("label", { class: "btn small file-btn" }, fileIn, "Dosya ekle");
  const fileChip = h("span", { class: "file-chip", hidden: true });
  const send = h("button", { class: "btn primary small", type: "button", text: "Gönder" });
  const status = h("p", { class: "form-err", role: "status" });
  const box = h("div", { class: "composer" },
    h("div", { class: "composer-row" }, kinds, h("span", { class: "as-who", text: benimAdim() + " olarak yazıyorsun" })),
    ta,
    h("div", { class: "composer-row" }, stamp, fileBtn, fileChip, h("span", { class: "spacer" }), send),
    status);

  function setTur(t) {
    tur = t; box.classList.toggle("is-revize", t === "revize");
    if (kinds) for (const b of kinds.children) b.setAttribute("aria-pressed", String(b.dataset.kind === t));
    ta.placeholder = t === "revize" ? "Neyin değişmesi gerekiyor? Ör. bu kısımdaki slayt yanlış, bir sonrakiyle değişmeli." : "Yorumunu yaz…";
    ta.setAttribute("aria-label", t === "revize" ? "Revize isteği" : "Yorum");
    fileBtn.hidden = t !== "revize";
    if (t !== "revize") setFile(null);
  }
  function setFile(f) {
    if (f && f.size > MAX_DOSYA) { status.style.color = ""; status.textContent = "Dosya 15 MB'tan büyük olamaz."; return; }
    file = f || null; fileIn.value = "";
    fileChip.hidden = !file;
    fileChip.replaceChildren(...(file ? [h("span", { text: file.name }), h("button", { type: "button", class: "linkish", "aria-label": "Dosyayı çıkar", text: "×", onclick: () => setFile(null) })] : []));
  }
  if (kinds) for (const b of kinds.children) b.addEventListener("click", () => setTur(b.dataset.kind));
  fileIn.addEventListener("change", () => setFile(fileIn.files[0]));
  if (revizeOlur) {
    box.addEventListener("dragover", (e) => { e.preventDefault(); box.classList.add("over"); });
    box.addEventListener("dragleave", (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove("over"); });
    box.addEventListener("drop", (e) => { e.preventDefault(); box.classList.remove("over"); if (e.dataTransfer.files[0]) { setTur("revize"); setFile(e.dataTransfer.files[0]); } });
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
      renderThread(); render();
    } catch {
      status.style.color = ""; status.textContent = "Gönderilemedi. İnternet bağlantını kontrol edip tekrar dene.";
    } finally { send.disabled = false; }
  });
  setTur(opts.revize && revizeOlur ? "revize" : "yorum");
  stampLabel();
  return box;
}

function renderThread() {
  const ul = $("#thread"), r = S.current && S.data.cekimler.find((x) => x.id === S.current);
  if (!ul || !r) return;
  const e = revOf(r.id);
  const items = [...e.notlar, ...e.dosyalar.map((f) => ({ ...f, eski: true }))].sort((a, b) => a.ts - b.ts);
  $("#thread-title").textContent = "Yorumlar ve revizeler" + (items.length ? " · " + items.length : "");
  if (!items.length) { ul.replaceChildren(h("li", { class: "thread-empty", text: REV() ? "Henüz yorum yok. Videoyu izleyip ilk yorumu sen yaz." : "Henüz yorum yok." })); return; }
  ul.replaceChildren(...items.map((it) => notEl(r, it)));
}
function notEl(r, it) {
  const li = h("li", { class: "note" + (it.eski || it.tur === "revize" ? " revize" : "") });
  if (it.eski) { fillNote(li, r, it, { tur: "revize", metin: "", yazan: "", tarih: new Date(it.ts).toISOString(), dosya: { path: it.path, ad: "Revizyon dosyası" } }); return li; }
  const k = NOTLAR.get(it.path);
  if (k) fillNote(li, r, it, k);
  else {
    li.append(h("div", { class: "skel line" }));
    notOku(it.path).then((k2) => { li.replaceChildren(); fillNote(li, r, it, k2); })
      .catch(() => li.replaceChildren(h("span", { class: "muted", text: "Bu kayıt okunamadı." })));
  }
  return li;
}
function fillNote(li, r, it, k) {
  const ad = k.yazan || (it.eski ? "Yüklenen dosya" : "İsimsiz");
  const silebilir = !it.eski && (S.edit || (k.yazanId && k.yazanId === S.myKeyId));
  const head = h("div", { class: "note-head" }, h("b", { text: ad }),
    k.tur === "revize" ? h("span", { class: "chip", style: "--c:var(--st-revize)", text: "Revize" }) : null,
    h("time", { datetime: k.tarih, title: fmtSaat(Date.parse(k.tarih) || it.ts), text: fmtGoreli(k.tarih) }));
  if (silebilir) {
    const del = h("button", { class: "linkish note-del", type: "button", text: "Sil" });
    del.addEventListener("click", async () => {
      if (!del.dataset.onay) { del.dataset.onay = "1"; del.textContent = "Silinsin mi? Evet"; return; }
      del.disabled = true;
      try { await notSil(r.id, it.path, k); renderThread(); render(); }
      catch { del.disabled = false; del.textContent = "Silinemedi"; }
    });
    head.append(del);
  }
  const body = h("div", { class: "note-body" }, head,
    Number.isFinite(k.sn) ? h("button", { class: "stamp", type: "button", title: "Videoda bu ana git", text: "▶ " + fmtSure(k.sn), onclick: () => seek(k.sn) }) : null,
    k.metin ? h("div", { class: "note-text", text: k.metin }) : null,
    k.dosya ? fileRow(k.dosya, it.eski) : null);
  li.append(h("span", { class: "avatar", style: `--c:var(${avatarRenk(ad)})`, "aria-hidden": "true", text: it.eski ? "↥" : basHarf(ad) }), body);
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
    const r = await fetch(`https://api.github.com/repos/${repo}`, { headers: { Authorization: "Bearer " + tok, Accept: "application/vnd.github+json" } });
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
  $("#rev-msg").textContent = y ? `Açık: hocalar revize dosyalarını ${y.repo} deposuna yükleyebilir.` : "Henüz ayarlanmadı: hocalar dosya yükleyemez.";
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
addEventListener("beforeunload", (e) => { if (S.dirty || S.saving) { e.preventDefault(); e.returnValue = ""; } });

// arada bir tazele; düzenleyen kişi de ekibin değişikliklerini görsün (kaydedilmemiş değişiklik ya da açık pencere yokken)
const tazelenir = () => !document.hidden && S.loaded && $("#lock").hidden && !S.dirty && !S.saving && !document.querySelector("dialog[open]");
setInterval(() => { if (tazelenir()) load({ quiet: true }); }, 180000);
document.addEventListener("visibilitychange", () => { if (tazelenir()) load({ quiet: true }); });

showMain();
render();
load();
