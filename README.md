# Shorten Link Transmigrasi v2.0

Aplikasi pemendek tautan resmi internal Kementerian Transmigrasi Republik Indonesia. Berjalan di Cloudflare Pages, datanya disimpan di Workers KV, dilengkapi sistem keamanan tinggi, manajemen kedaluwarsa tautan, generator QR Code, dan panel manajemen khusus Super Admin.

## Isi Project

```
public/
  index.html      tampilan dashboard terintegrasi (login, tautan, pengguna, statistik)
  app.js          logika frontend: filter satker, CRUD pengguna, QR code, ekspor CSV, grafik
  logo.jpg        logo resmi Kementerian Transmigrasi
  _worker.js      seluruh backend serverless & REST API
  _routes.json    routing Pages
scripts/
  tools.mjs       script CLI pembuatan superadmin (PBKDF2) & ekspor/impor data KV
wrangler.toml     konfigurasi Pages + binding KV (LINKS)
```

## Fitur Utama & Pembaruan (v2.0)

1. **Keamanan Login Tinggi**:
   - Algoritma hashing ditingkatkan ke **PBKDF2-HMAC-SHA256 (100.000 iterasi)** dengan salt acak (kompatibel transparan dengan akun lama).
   - **Rate Limiting Anti-Brute Force**: Pembatasan percobaan login gagal (kunci sementara setelah 5x gagal dalam 15 menit).
   - **Reserved Aliases Protection**: Mencegah benturan rute seperti `/api`, `/admin`, `/login`, dll.
   - **Security Headers HTTP**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`.

2. **Masa Berlaku Tautan (Link Expiry) & Status**:
   - Pengaturan batas waktu aktif tautan (`expiresAt`) opsional.
   - Halaman pengalihan resmi khusus untuk tautan kedaluwarsa (*410 Link Expired*) dan dinonaktifkan (*403 Inactive*).

3. **Generator QR Code Resmi**:
   - Generator QR Code otomatis untuk setiap tautan pendek.
   - Opsi unduh gambar QR Code resolusi tinggi (.PNG) untuk kebutuhan surat dinas, banner, dan spanduk.

4. **Header Dashboard Kompak**:
   - Tata letak dashboard diperbarui agar hemat ruang vertikal (*compact viewport*), sehingga data tabel langsung terlihat jelas.

5. **Manajemen Pengguna Lengkap (Khusus Super Admin)**:
   - Pembuatan akun pengguna/pegawai hanya dapat dilakukan oleh Super Admin.
   - Fitur Edit Data Pengguna (Nama, Instansi, Role).
   - Fitur Reset Password Pengguna dengan generator sandi acak.
   - Fitur Nonaktifkan/Aktifkan Akun (Suspend/Active).
   - Filter dan pencarian pengguna berbasis nama/satker.

6. **Penyempurnaan Manajemen Tautan**:
   - Edit URL tujuan dan tanggal kedaluwarsa tanpa mengubah kode pendek.
   - Filter tautan berdasarkan Satker/Instansi dan Status (Aktif/Kedaluwarsa/Nonaktif).
   - Ekspor data tautan ke file **CSV / Excel** sekali klik.

7. **Dashboard Statistik Eksekutif**:
   - Widget **Top 5 Tautan Paling Banyak Diklik**.
   - Leaderboard **Satker / Instansi Teraktif**.
   - Grafik kurva tren 7 hari (Pengguna, Tautan, Klik).

## Endpoint API

| Method | Path | Hak Akses | Keterangan |
|---|---|---|---|
| POST | `/api/login`, `/api/logout` | Publik | Login dengan rate-limit dan cookie HttpOnly |
| GET | `/api/me` | Publik | Cek sesi login aktif |
| GET | `/api/links` | User / Admin | Mengambil daftar tautan |
| POST | `/api/links` | User / Admin | Membuat tautan baru |
| POST | `/api/links/update` | Pembuat / Admin | Mengedit URL asli, batas waktu, & status |
| DELETE | `/api/links` | Pembuat / Admin | Menghapus tautan |
| GET | `/api/admin/users` | Super Admin | Mengambil daftar pengguna |
| POST | `/api/admin/create-user` | Super Admin | Membuat akun pengguna baru |
| POST | `/api/admin/update-user` | Super Admin | Mengubah data profil/status pengguna |
| POST | `/api/admin/reset-password` | Super Admin | Mereset kata sandi pengguna |
| POST | `/api/admin/delete-user` | Super Admin | Menghapus akun pengguna |
| GET | `/api/admin/stats` | Super Admin | Metrik statistik, Top 5 & Leaderboard |
| GET | `/<kode>` | Publik | Pengalihan 302 instan ke URL tujuan |

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
