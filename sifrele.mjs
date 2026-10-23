// Trigemy · Montaj Takibi — şifresiz data.json'ı bir kez şifreler ve ilk (yönetici) erişim anahtarını üretir.
// Kullanım: node sifrele.mjs [data.json yolu]
// Biçim app.js ile aynı: veri rastgele veri anahtarıyla AES-GCM şifreli; her erişim anahtarı veri anahtarını PBKDF2 ile sarar.
// Sonraki anahtarlar sitede "Düzenle → Erişim anahtarları" ile üretilir.
import { webcrypto as wc } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ITER = 100000;
const ALFABE = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const file = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "data.json");
const b64 = (b) => Buffer.from(b).toString("base64");
const rnd = (n) => wc.getRandomValues(new Uint8Array(n));
const te = new TextEncoder();

const data = JSON.parse(readFileSync(file, "utf8"));
if (data.sifreli) { console.log("data.json zaten şifreli. Yeni anahtarı sitede Düzenle → Erişim anahtarları'ndan üret."); process.exit(0); }

const key = Array.from(rnd(16), (x) => ALFABE[x % ALFABE.length]).join("").match(/.{4}/g).join("-");
const id = "k" + Date.now().toString(36);
const now = new Date().toISOString();
data.erisim = [{ id, ad: "Yönetici", olusturma: now }];

const dek = await wc.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
const iv = rnd(12);
const ct = await wc.subtle.encrypt({ name: "AES-GCM", iv }, dek, te.encode(JSON.stringify(data)));

const salt = rnd(16), wiv = rnd(12);
const base = await wc.subtle.importKey("raw", te.encode(key.replace(/-/g, "")), "PBKDF2", false, ["deriveKey"]);
const kek = await wc.subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
const wrapped = await wc.subtle.encrypt({ name: "AES-GCM", iv: wiv }, kek, await wc.subtle.exportKey("raw", dek));

// doğrulama: anahtarla geri açılıyor mu
const raw = await wc.subtle.decrypt({ name: "AES-GCM", iv: wiv }, kek, wrapped);
const dek2 = await wc.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
const back = JSON.parse(new TextDecoder().decode(await wc.subtle.decrypt({ name: "AES-GCM", iv }, dek2, ct)));
if (back.cekimler.length !== data.cekimler.length) throw new Error("doğrulama başarısız");

writeFileSync(file, JSON.stringify({
  sifreli: true, v: 2, iv: b64(iv), ct: b64(new Uint8Array(ct)),
  anahtarlar: [{ id, iter: ITER, salt: b64(salt), iv: b64(wiv), k: b64(new Uint8Array(wrapped)) }],
}, null, 2) + "\n");

console.log(`\n  data.json şifrelendi (${data.cekimler.length} çekim).\n`);
console.log("  YÖNETİCİ ERİŞİM ANAHTARIN:\n");
console.log("      " + key + "\n");
console.log("  Bunu güvenli bir yere kaydet (ör. şifre yöneticisi). Siteye bununla girersin;");
console.log("  diğer kişilerin anahtarlarını sitede Düzenle → Erişim anahtarları'ndan üretirsin.\n");
