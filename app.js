"use strict";
/* Trigemy · Montaj Takibi
   Veri: depodaki data.json. Herkes okur; düzenleme modunda GitHub anahtarıyla aynı dosyaya commit atılır. */

const DURUMLAR = [
  { id: "bekliyor",    ad: "Montaj Bekliyor", renk: "--st-bekliyor" },
  { id: "montajda",    ad: "Montajda",        renk: "--st-montajda" },
  { id: "revize",      ad: "Revizede",        renk: "--st-revize" },
  { id: "montajlandi", ad: "Montajlandı",     renk: "--st-montajlandi" },
  { id: "yayinda",     ad: "Yayında",         renk: "--st-yayinda" },
];
const BITEN = new Set(["montajlandi", "yayinda"]);
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
    let text = null;
    if (API) {
      const headers = { Accept: "application/vnd.github+json" };
      if (S.token) headers.Authorization = "Bearer " + S.token;
      const r = await fetch(`${API}?ref=${encodeURIComponent(CFG.branch)}`, { headers, cache: "no-store" });
      if (r.ok) { const j = await r.json(); S.sha = j.sha; text = b64dec(j.content); }
      else if (r.status === 401 && S.token) { logout("GitHub anahtarı geçersiz ya da süresi dolmuş. Yeniden bağlan."); }
    }
    if (text == null) {   // API yoksa ya da kota dolduysa sitedeki kopya
      const r = await fetch(CFG.path + "?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) throw new Error("data.json okunamadı (" + r.status + ")");
      text = await r.text();
    }
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
      S.data = normalize(plain);
    } else {
      S.enc = false;
      S.data = normalize(doc);
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

function mutate(fn, ozet) {
  fn();
  S.data.guncelleme = new Date().toISOString();
  S.dirty = true; S.lastMsg = ozet || "Pano güncellendi";
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
    const out = S.enc ? await encryptDoc(S.data, S.dek, S.anahtarlar) : S.data;
    const body = JSON.stringify(out, null, 2) + "\n";
    const r = await fetch(API, {
      method: "PUT",
      headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + S.token, "Content-Type": "application/json" },
      body: JSON.stringify({ message: S.lastMsg, content: b64enc(body), sha: S.sha || undefined, branch: CFG.branch }),
    });
    if (r.ok) {
      S.sha = (await r.json()).content.sha;
      syncChip("Kaydedildi", "var(--ok)");
    } else if ((r.status === 409 || r.status === 422) && retry) {
      // dosya başka yerden değişmiş: güncel sha'yı alıp bizim halimizi yeniden yaz
      const g = await fetch(`${API}?ref=${encodeURIComponent(CFG.branch)}`, { headers: { Authorization: "Bearer " + S.token }, cache: "no-store" });
      if (g.ok) S.sha = (await g.json()).sha;
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
  const all = S.data.cekimler;
  const n = all.length;
  const sayi = Object.fromEntries(DURUMLAR.map((d) => [d.id, all.filter((r) => r.durum === d.id).length]));
  const biten = all.filter((r) => BITEN.has(r.durum)).length;
  const pct = n ? Math.round((biten / n) * 100) : 0;

  // genel durum
  $("#pct").textContent = pct + "%";
  $("#ring-val").style.strokeDashoffset = String(326.73 * (1 - (n ? biten / n : 0)));
  $("#ring").setAttribute("aria-label", `Tamamlanma oranı yüzde ${pct}`);
  $("#done-line").textContent = S.loaded ? (n ? `${n} çekimden ${biten} tanesinin montajı tamamlandı` : "Henüz çekim eklenmedi") : "—";
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
  const c = h("article", { class: "card", tabindex: "0", draggable: S.edit ? "true" : null, style: `--c:${cssVar(d.renk)}`, "aria-label": `${r.egitmen}, ${cekimAdi(r)}, ${d.ad}` },
    h("div", { class: "card-top" }, h("div", { class: "card-name", text: r.egitmen || "İsimsiz" }), r.sira ? h("span", { class: "card-no", text: "#" + r.sira }) : null),
    h("div", { class: "chips" },
      h("span", { class: "chip " + r.tur, text: cekimAdi(r) }),
      r.disk ? h("span", { class: "chip warn", text: "Medya başka diskte" }) : null,
      r.teslim ? h("span", { class: "chip date", text: "Teslim " + fmtKisa(r.teslim) }) : null),
    r.not ? h("div", { class: "card-note", text: r.not }) : null,
    revizeChip(r),
    r.durum === "yayinda" && (safeUrl(r.link) || REV()) ? h("div", { class: "card-acts" },
      safeUrl(r.link) ? h("a", { class: "btn small primary", href: safeUrl(r.link), target: "_blank", rel: "noopener noreferrer", text: "Videoyu indir", onclick: (e) => e.stopPropagation() }) : null,
      REV() ? h("button", { class: "btn small", type: "button", text: "Revizyon yükle", onclick: (e) => { e.stopPropagation(); openItem(r.id, { upload: true }); } }) : null) : null,
    h("div", { class: "card-foot" }, h("span", { text: fmtGoreli(r.guncelleme) }), sel),
  );
  c.addEventListener("click", () => openItem(r.id));
  c.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openItem(r.id); } });
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
      h("td", null, h("span", { class: "chip " + r.tur, text: cekimAdi(r) }), r.disk ? [" ", h("span", { class: "chip warn", text: "Başka diskte" })] : null),
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
  if (durum === "yayinda" && !r.link) openItem(id, { focus: "#f-link" });   // yayına çıkan videonun indirme linki
}

/* ---------- ayrıntı / düzenleme penceresi ---------- */
const dlg = $("#dlg-item");
for (const d of DURUMLAR) $("#f-durum").append(h("option", { value: d.id, text: d.ad }));

function openItem(id, opts = {}) {
  const r = id ? S.data.cekimler.find((x) => x.id === id) : null;
  S.current = r ? r.id : null;
  const d = durumOf(r ? r.durum : "bekliyor");
  $("#item-eyebrow").textContent = r ? cekimAdi(r) : "Yeni kayıt";
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
  $("#f-disk").checked = !!r?.disk;
  $("#f-not").value = r?.not || "";
  $("#f-link").value = r?.link || "";
  $("#f-err").textContent = "";
  renderExtra(r, opts);

  const editing = S.edit;
  view.hidden = editing || !r;
  $("#item-edit").hidden = !editing;
  $("#item-foot").hidden = !editing;
  $("#btn-del").hidden = !r; $("#del-confirm").hidden = true;
  dlg.showModal();
  if (editing && !r) $("#f-egitmen").focus();
  if (editing && opts.focus) $(opts.focus).focus();
}
function fact(label, val) { return h("div", { class: "fact" }, h("span", { text: label }), typeof val === "string" ? h("b", { text: val }) : val); }

$("#item-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!S.edit) return dlg.close();
  const egitmen = $("#f-egitmen").value.trim();
  if (!egitmen) { $("#f-err").textContent = "Eğitmen adını yaz."; return; }
  const sira = parseInt($("#f-sira").value, 10);
  const val = {
    egitmen, tur: $("#f-tur").value, durum: $("#f-durum").value, sira: Number.isFinite(sira) ? sira : null,
    teslim: $("#f-teslim").value, ad: $("#f-ad").value.trim(), disk: $("#f-disk").checked, not: $("#f-not").value.trim(),
    link: $("#f-link").value.trim(),
  };
  if (val.link && !safeUrl(val.link)) { $("#f-err").textContent = "İndirme linki http:// ya da https:// ile başlamalı."; return; }
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
  $("#main").hidden = true; $("#lock").hidden = false; $("#btn-mode").hidden = true;
  $("#lock-pass").value = ""; $("#lock-err").textContent = "";
  $("#lock-pass").focus();
}
function showMain() { $("#lock").hidden = true; $("#main").hidden = false; $("#btn-mode").hidden = false; }
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
    S.data = normalize(plain); S.loaded = true;
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

/* ---------- indirme linki ve revizyon dosyaları ----------
   Hocalar revize dosyasını ayrı bir depoya (ör. Trigemy-revize) yükler; yalnız o depoya yazabilen anahtar şifreli veride durur.
   Dosyalar veri anahtarıyla şifrelenip <çekim id>/<zaman>-<rastgele>.enc olarak yazılır. */
const REV = () => (S.data.yukleme && S.data.yukleme.token && S.data.yukleme.repo ? S.data.yukleme : null);
const safeUrl = (u) => (/^https?:\/\/[^\s]+$/i.test(u || "") ? u : "");
const MAX_DOSYA = 15 * 1024 * 1024;
const revApi = (y, path = "") => `https://api.github.com/repos/${y.repo}/contents/${path}`;
const revHeaders = (y, raw) => ({ Authorization: "Bearer " + y.token, Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json" });

async function loadRevize() {
  const y = REV();
  if (!y || !S.dek) { S.revize = {}; return; }
  try {
    const r = await fetch(`https://api.github.com/repos/${y.repo}/git/trees/${y.branch || "main"}?recursive=1`, { headers: revHeaders(y), cache: "no-store" });
    if (r.status === 404 || r.status === 409) { S.revize = {}; return; }   // depo boş
    if (!r.ok) return;
    const m = {};
    for (const t of (await r.json()).tree || []) {
      const mm = t.type === "blob" && t.path.match(/^([^/]+)\/(\d+)-[a-z0-9]+\.enc$/);
      if (mm) (m[mm[1]] ||= []).push({ path: t.path, ts: +mm[2] });
    }
    for (const k in m) m[k].sort((a, b) => b.ts - a.ts);
    S.revize = m;
  } catch { /* liste alınamadı; sonraki yüklemede tekrar denenir */ }
}
function revizeChip(r) {
  const f = S.revize[r.id];
  if (!f || !f.length) return null;
  const yeni = f[0].ts > Date.parse(r.guncelleme || 0);
  return h("div", { class: "chips" }, h("span", { class: "chip " + (yeni ? "date" : ""), style: yeni ? null : "--c:var(--brand)",
    text: (yeni ? "Yeni revize · " : "") + f.length + " revize dosyası" }));
}

async function uploadRevize(cekimId, file) {
  const y = REV();
  const me = (S.data.erisim || []).find((x) => x.id === S.myKeyId);
  const head = new TextEncoder().encode(JSON.stringify({ ad: file.name, tip: file.type, boyut: file.size, tarih: new Date().toISOString(), yukleyen: me ? me.ad : "" }));
  const plain = new Uint8Array(4 + head.length + file.size);
  new DataView(plain.buffer).setUint32(0, head.length);
  plain.set(head, 4); plain.set(new Uint8Array(await file.arrayBuffer()), 4 + head.length);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, S.dek, plain));
  const blob = new Uint8Array(12 + ct.length); blob.set(iv); blob.set(ct, 12);
  const ts = Date.now(), path = `${cekimId}/${ts}-${Math.random().toString(36).slice(2, 8)}.enc`;
  const r = await fetch(revApi(y, path), {
    method: "PUT", headers: { ...revHeaders(y), "Content-Type": "application/json" },
    body: JSON.stringify({ message: "Revizyon dosyası", content: bytesb64(blob), branch: y.branch || "main" }),
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  (S.revize[cekimId] ||= []).unshift({ path, ts });
}
async function downloadRevize(path) {
  const y = REV();
  const r = await fetch(revApi(y, path) + "?ref=" + encodeURIComponent(y.branch || "main"), { headers: revHeaders(y, true), cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const buf = new Uint8Array(await r.arrayBuffer());
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.subarray(0, 12) }, S.dek, buf.subarray(12)));
  const n = new DataView(plain.buffer).getUint32(0);
  const head = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + n)));
  const url = URL.createObjectURL(new Blob([plain.subarray(4 + n)], { type: head.tip || "application/octet-stream" }));
  const a = h("a", { href: url, download: head.ad || "revize" });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return head;
}
const fmtSaat = (ts) => new Date(ts).toLocaleString("tr-TR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

function renderExtra(r, opts = {}) {
  const box = $("#item-extra");
  if (!r) { box.replaceChildren(); box.hidden = true; return; }
  const files = S.revize[r.id] || [];
  const canUpload = REV() && (r.durum === "yayinda" || r.durum === "revize" || S.edit);
  const status = h("p", { class: "form-err", role: "status" });
  const input = h("input", { type: "file", class: "sr", accept: ".pdf,.doc,.docx,.txt,.rtf,.odt,.pages,.md,application/pdf,text/plain,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  async function send(file) {
    if (!file) return;
    if (file.size > MAX_DOSYA) { status.textContent = "Dosya 15 MB'tan büyük olamaz."; return; }
    status.style.color = "var(--muted)"; status.textContent = `“${file.name}” yükleniyor…`;
    try { await uploadRevize(r.id, file); status.style.color = "var(--ok)"; status.textContent = `“${file.name}” yüklendi. Teşekkürler!`; render(); renderList(); }
    catch { status.style.color = ""; status.textContent = "Yüklenemedi. İnternet bağlantını kontrol edip tekrar dene."; }
  }
  input.addEventListener("change", () => send(input.files[0]));
  const drop = canUpload ? h("label", { class: "drop" }, input,
    h("b", { text: "Revizyon dosyası yükle" }), h("span", { text: "Dosyayı buraya sürükle ya da seçmek için tıkla · PDF, Word, TXT" })) : null;
  if (drop) {
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); send(e.dataTransfer.files[0]); });
  }
  const list = h("ul", { class: "file-list" });
  function renderList() {
    const fs = S.revize[r.id] || [];
    list.replaceChildren(...fs.map((f) => {
      const name = h("span", { text: "Revizyon dosyası · " + fmtSaat(f.ts) });
      const btn = h("button", { class: "btn small", type: "button", text: "İndir" });
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try { const hd = await downloadRevize(f.path); name.textContent = hd.ad + (hd.yukleyen ? " · " + hd.yukleyen : "") + " · " + fmtSaat(f.ts); }
        catch { btn.textContent = "İndirilemedi"; }
        finally { btn.disabled = false; }
      });
      return h("li", null, name, btn);
    }));
    list.hidden = !fs.length;
  }
  renderList();
  const link = safeUrl(r.link);
  box.replaceChildren(...[
    link ? h("a", { class: "btn primary dl", href: link, target: "_blank", rel: "noopener noreferrer" },
      h("svg", { viewBox: "0 0 20 20", "aria-hidden": "true" }), "Videoyu indir") : null,
    files.length || canUpload ? h("p", { class: "sec-title", text: "Revizyon dosyaları" }) : null,
    list, drop, status,
  ].filter(Boolean));
  const svg = box.querySelector(".dl svg");
  if (svg) svg.innerHTML = '<path d="M10 3v10m0 0-4-4m4 4 4-4M4 16h12"/>';
  box.hidden = !box.children.length || (!link && !files.length && !canUpload);
  if (opts.upload && drop) setTimeout(() => drop.scrollIntoView({ block: "nearest" }), 50);
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
for (const b of document.querySelectorAll("[data-tur]")) b.addEventListener("click", () => {
  S.tur = b.dataset.tur;
  for (const x of document.querySelectorAll("[data-tur]")) x.setAttribute("aria-pressed", String(x === b));
  render();
});
let qt; $("#q").addEventListener("input", (e) => { clearTimeout(qt); qt = setTimeout(() => { S.q = trLower(e.target.value.trim()); render(); }, 120); });
$("#btn-add").addEventListener("click", () => openItem(null));
addEventListener("beforeunload", (e) => { if (S.dirty || S.saving) { e.preventDefault(); e.returnValue = ""; } });

// izleyiciler için arada bir tazele (GitHub'ın anahtarsız kotası saatte 60 istek)
setInterval(() => { if (!document.hidden && !S.edit && $("#lock").hidden) load({ quiet: true }); }, 180000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && !S.edit && S.loaded && $("#lock").hidden) load({ quiet: true }); });

showMain();
render();
load();
