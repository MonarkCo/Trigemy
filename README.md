# Trigemy · Montaj Takibi

Trigemy eğitim videolarının montaj sürecini gösteren takip panosu.
Adres: **https://monarkco.github.io/Trigemy/**

- **Giriş:** Linki açan herkesin önüne anahtar ekranı gelir. Kullanıcı adı yok, yalnız `XXXX-XXXX-XXXX-XXXX` biçiminde bir erişim anahtarı girilir.
- **Hocalar:** Anahtarlarıyla girip gidişatı görür. Yayındaki videoyu **Videoyu indir** ile indirir, **Revizyon dosyası yükle** ile revize notunu (PDF, Word, TXT) yükler.
- **Yönetici (sen):** **Düzenle** ile kartları taşır, not ve link girer. **Erişim anahtarları** panelinden kişi başı anahtar üretir ya da siler.

## Güvenlik nasıl sağlanıyor

- Bütün veriler (`data.json`) şifreli: AES-256-GCM, anahtar türetme PBKDF2. Depo herkese açık olsa da anahtarı olmayan hiçbir şey okuyamaz.
- Her kişinin anahtarı ayrı. Bir anahtarı silersen o kişi bir daha giremez, diğerleri etkilenmez.
- Revize dosyaları ayrı bir depoya (`Trigemy-revize`) yine şifreli yüklenir. Hocalar yalnız o depoya dosya ekleyebilir; panoyu değiştiremez.
- Sayfanın kodu (HTML/CSS/JS) herkese açıktır; içerik değildir.

## Kurulum (bir kez)

1. **İki depo oluştur (ikisi de Public):**
   - `MonarkCo/Trigemy`: bu klasördeki dosyalar.
   - `MonarkCo/Trigemy-revize`: boş depo; revize dosyaları buraya gelir.
2. **Verileri şifrele:** Bu klasörde `node sifrele.mjs` çalıştır. Ekrana **yönetici erişim anahtarın** çıkar; bir şifre yöneticisine kaydet. Bu adım `data.json`'ı yayından önce şifreler.
3. **Pages'i aç:** `Trigemy` deposunda `Settings → Pages → Deploy from a branch`, dal `main`, klasör `/ (root)`.
4. **Yönetici GitHub anahtarı** (Düzenle için): GitHub → `Settings → Developer settings → Fine-grained tokens → Generate new token`
   - Repository access: **Trigemy** ve **Trigemy-revize**
   - Permissions → **Contents: Read and write**
5. **Yükleme anahtarı** (hocaların dosya yüklemesi için): aynı yerden ikinci bir anahtar oluştur.
   - Repository access: **yalnız Trigemy-revize**
   - Permissions → **Contents: Read and write**
6. Siteyi aç, yönetici erişim anahtarınla gir → **Düzenle** → yönetici GitHub anahtarını yapıştır → **Erişim anahtarları** → en alttaki *Revize dosyası yükleme* bölümüne yükleme anahtarını gir.
7. Aynı panelden her hoca için **Anahtar üret** → **Link + anahtar mesajını kopyala** → hocaya gönder.

## Notlar

- GitHub anahtarlarının süresi dolunca (oluştururken seçtiğin süre) yenisini üretip aynı yerlere girmen yeterli.
- Yönetici erişim anahtarını kaybedersen: başka bir geçerli anahtarla girip panelden yeni bir yönetici anahtarı üret. Bütün anahtarlar kaybolursa veriler açılamaz.
- İzleyici sayfası 3 dakikada bir kendini tazeler.
- Durumlar: Montaj Bekliyor → Montajda → Revizede → Montajlandı → Yayında. Kart Yayında'ya taşınınca indirme linki sorulur.
- Dosyalar: `index.html` (sayfa ve depo ayarı), `style.css`, `app.js`, `data.json` (şifreli veri), `logo.png`, `sifrele.mjs` (ilk şifreleme).
