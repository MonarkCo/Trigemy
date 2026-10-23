// Trigemy · Montaj Takibi — sitedeki "Erişim anahtarları" panelinin komut satırı karşılığı.
// Kullanım: node anahtar_ekle.mjs <isimler.txt>   (her satıra bir kişi adı)
// Yönetici anahtarı ekranda görünmeden sorulur; yeni anahtarlar ekrana yazılır, data.json güncellenir.
import { webcrypto as wc } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ITER = 100000;
const ALFABE = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const file = join(dirname(fileURLToPath(import.meta.url)), "data.json");
const b64 = (b) => Buffer.from(b).toString("base64");
const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
const rnd = (n) => wc.getRandomValues(new Uint8Array(n));
const te = new TextEncoder();
const norm = (s) => s.toUpperCase().replace(/[^0-9A-Z]/g, "");

function ask(q) {
  return new Promise((res) => {
    process.stdout.write(q);
    const s = process.stdin;
    if (!s.isTTY) { s.setEncoding("utf8"); s.once("data", (d) => { s.pause(); res(String(d).split(/\r?\n/)[0]); }); return; }
    s.setRawMode(true); s.resume(); s.setEncoding("utf8");
    let v = "";
    const on = (chunk) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") { s.setRawMode(false); s.pause(); s.off("data", on); process.stdout.write("\n"); return res(v); }
        if (c === "\u0003") { process.stdout.write("\n"); process.exit(1); }
        if (c === "\u007f" || c === "\b") { v = v.slice(0, -1); continue; }
        v += c;
      }
    };
    s.on("data", on);
  });
}
async function kek(n, salt, iter) {
  const base = await wc.subtle.importKey("raw", te.encode(n), "PBKDF2", false, ["deriveKey"]);
  return wc.subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

const isimler = readFileSync(process.argv[2], "utf8").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
if (!isimler.length) { console.log("İsim listesi boş."); process.exit(1); }
const doc = JSON.parse(readFileSync(file, "utf8"));
if (!doc.sifreli) { console.log("data.json şifreli değil; önce sifrele.mjs çalıştır."); process.exit(1); }

let dek = null;
for (let deneme = 0; deneme < 3 && !dek; deneme++) {
  const n = norm(await ask("Yönetici erişim anahtarın (ekranda görünmez): "));
  for (const a of doc.anahtarlar) {
    try {
      const raw = await wc.subtle.decrypt({ name: "AES-GCM", iv: unb64(a.iv) }, await kek(n, unb64(a.salt), a.iter || ITER), unb64(a.k));
      dek = await wc.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
      break;
    } catch { /* sıradaki sargı */ }
  }
  if (!dek) console.log("Anahtar geçersiz, tekrar dene.");
}
if (!dek) process.exit(1);

const data = JSON.parse(new TextDecoder().decode(await wc.subtle.decrypt({ name: "AES-GCM", iv: unb64(doc.iv) }, dek, unb64(doc.ct))));
const rawDek = await wc.subtle.exportKey("raw", dek);
const now = new Date().toISOString();
const yeni = [];
for (const ad of isimler) {
  const key = Array.from(rnd(16), (x) => ALFABE[x % ALFABE.length]).join("").match(/.{4}/g).join("-");
  const id = "k" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const salt = rnd(16), iv = rnd(12);
  const k = await wc.subtle.encrypt({ name: "AES-GCM", iv }, await kek(norm(key), salt, ITER), rawDek);
  doc.anahtarlar.push({ id, iter: ITER, salt: b64(salt), iv: b64(iv), k: b64(new Uint8Array(k)) });
  (data.erisim ||= []).push({ id, ad, olusturma: now });
  yeni.push([ad, key]);
}
data.guncelleme = now;
const iv = rnd(12);
const ct = await wc.subtle.encrypt({ name: "AES-GCM", iv }, dek, te.encode(JSON.stringify(data)));
writeFileSync(file, JSON.stringify({ sifreli: true, v: 2, iv: b64(iv), ct: b64(new Uint8Array(ct)), anahtarlar: doc.anahtarlar }, null, 2) + "\n");

console.log("\n  Yeni erişim anahtarları (her biri yalnız şimdi gösteriliyor):\n");
for (const [ad, key] of yeni) console.log(`    ${ad.padEnd(22)} ${key}`);
console.log("\n  Site: https://monarkco.github.io/Trigemy/");
console.log("  Bu pencereyi kapatmadan önce anahtarları kopyala.\n");
