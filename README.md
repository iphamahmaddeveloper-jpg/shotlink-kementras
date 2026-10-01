# Shorten Link Transmigrasi v2.1

Aplikasi pemendek tautan resmi internal Kementerian Transmigrasi Republik Indonesia. Berjalan di Cloudflare Pages, datanya disimpan di Workers KV, dilengkapi sistem keamanan tinggi, manajemen kedaluwarsa tautan, proteksi PIN, UTM campaign builder, generator QR Code berlogo, dan panel manajemen Super Admin.

## Isi Project

```
public/
  index.html      tampilan dashboard terintegrasi (login, tautan, pengguna, statistik)
  app.js          logika frontend: filter satker, CRUD pengguna, QR code berlogo, UTM builder, ekspor CSV, grafik
  logo.jpg        logo resmi Kementerian Transmigrasi
  _worker.js      seluruh backend serverless & REST API
  _routes.json    routing Pages
scripts/
  tools.mjs       script CLI pembuatan superadmin (PBKDF2) & ekspor/impor data KV
wrangler.toml     konfigurasi Pages + binding KV (LINKS)
```

## Fitur Utama & Pembaruan (v2.1)

1. **Ganti Kata Sandi Mandiri**:
   - Pegawai/User dapat mengubah kata sandinya sendiri langsung dari menu navbar dashboard (`/api/change-password`) tanpa harus menghubungi Super Admin.

2. **Proteksi PIN Akses pada Tautan (Opsional)**:
   - Tautan sensitif / internal dapat diproteksi dengan PIN 4-6 digit.
   - Pengunjung publik akan diarahkan ke halaman input PIN resmi Kementerian Transmigrasi sebelum dialihkan ke dokumen/tujuan asli.

3. **UTM Campaign Builder (Humas / Publikasi)**:
   - Form pembuatan & edit link dilengkapi generator parameter UTM (`utm_source`, `utm_medium`, `utm_campaign`) otomatis untuk pelacakan kampanye humas dan media sosial.

4. **Branded QR Code dengan Logo Resmi di Tengah**:
   - Generator QR Code otomatis menyematkan logo resmi Kementerian Transmigrasi di tengah matriks QR dengan koreksi eror Level H.
   - Opsi unduh: **Kartu Gambar QR Resmi (PNG)**, **QR Code Berlogo (PNG)**, dan **QR Polos (PNG)**.

5. **Paginasi & Optimasi Tabel Tautan**:
   - Tabel tautan dilengkapi navigasi halaman dinamis (10, 25, 50 data per halaman) dan pencarian instan.

6. **Pencatatan Klik Harian Akurat (WIB)**:
   - Backend mencatat counter klik aktual harian (`dayclicks:YYYY-MM-DD`) secara terpisah, sehingga grafik tren klik 7 hari mencerminkan lonjakan trafik harian yang sebenarnya.

7. **Keamanan Login & Tata Kelola Lengkap**:
   - Hashing **PBKDF2-HMAC-SHA256 (100.000 iterasi)** dengan salt acak.
   - Rate limiting brute force (kunci sementara setelah percobaan gagal).
   - Ekspor seluruh tautan ke file **CSV / Excel** sekali klik.

## Endpoint API

| Method | Path | Hak Akses | Keterangan |
|---|---|---|---|
| POST | `/api/login`, `/api/logout` | Publik | Login dengan rate-limit dan cookie HttpOnly |
| GET | `/api/me` | Publik | Cek sesi login aktif |
| POST | `/api/change-password` | User / Admin | Ganti kata sandi akun sendiri |
| GET | `/api/links` | User / Admin | Mengambil daftar tautan |
| POST | `/api/links` | User / Admin | Membuat tautan baru (mendukung PIN & Expiry) |
| POST | `/api/links/update` | Pembuat / Admin | Mengedit URL asli, batas waktu, PIN, & status |
| DELETE | `/api/links` | Pembuat / Admin | Menghapus tautan |
| GET | `/api/admin/users` | Super Admin | Mengambil daftar pengguna |
| POST | `/api/admin/create-user` | Super Admin | Membuat akun pengguna baru |
| POST | `/api/admin/update-user` | Super Admin | Mengubah data profil/status pengguna |
| POST | `/api/admin/reset-password` | Super Admin | Mereset kata sandi pengguna |
| POST | `/api/admin/delete-user` | Super Admin | Menghapus akun pengguna |
| GET | `/api/admin/stats` | Super Admin | Metrik statistik, Top 5 & Leaderboard |
| GET/POST | `/<kode>` | Publik | Pengalihan 302 instan atau verifikasi PIN |

## Menjalankan dan Deploy

```bash
# Instalasi dependensi
npm install

# Menjalankan lokal
npm run dev

# Deploy ke Cloudflare Pages
npm run deploy
```

Untuk membuat Super Admin pertama (saat KV masih kosong):
```bash
node scripts/tools.mjs create-admin admin <password> "Nama Lengkap" "Instansi"
```
Jalankan perintah `wrangler kv key put ...` yang dicetak di terminal.
