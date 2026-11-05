# EIS Training Studio — prototipe Vercel + GPU laptop

Proyek berada di `D:\COOLYEAH\TA\EIS\code\prototype`. Referensi implementasi adalah folder saudara `endemic-indonesia-frontend` dan `endemic-indonesia-backend`. Kedua repo acuan dan database website EIS tidak diubah.

## Stack dan batas prototipe

| Bagian | Implementasi |
| --- | --- |
| Frontend | React 19, TypeScript 5, Vite 7, React Router 7, CSS biasa |
| Backend | Express 5, TypeScript, JWT, bcrypt, Zod |
| Database | PostgreSQL melalui Prisma 7 dan adapter pg |
| Storage opsional | Bucket Supabase privat untuk model ZIP |
| Worker laptop | Python 3.12, PyTorch 2.9.1 CUDA 12.6, NumPy, scikit-learn |

Versi patch/minor beberapa paket diperbarui dari acuan untuk mengatasi advisori npm; bcrypt memakai versi 6 dengan API hashing yang sama. Versi tepat dikunci di masing-masing package-lock.json.

**Model masih demonstrasi:** dataset digits berisi 1.797 gambar angka 8×8, MLP 64→128→64→10. Model burung/capung, preprocessing Excel, audio, raster, heatmap, dan rekomendasi EIS belum diimplementasikan. Ini validasi arsitektur training online dengan worker laptop. Semua eksperimen dimulai dari awal; resume checkpoint belum tersedia.

## Menjalankan worker tanpa terminal (Windows)

Buka halaman **Perangkat lokal**. Tombol **Siapkan worker (Windows)** mengunduh ZIP launcher; ekstrak, lalu jalankan INSTALL.cmd sekali. Python 3.12 dengan Tcl/Tk harus tersedia. Launcher menyediakan tombol Siapkan dependensi, Impor koneksi, Jalankan worker, dan Hentikan worker.

Pada laptop pengembangan ini launcher sudah didaftarkan dari folder **worker/** dan lingkungan Python sudah tersedia. Gunakan tombol **Jalankan worker** pada website. Tidak perlu mengunduh ZIP atau memasang PyTorch lagi. Browser dapat meminta izin membuka aplikasi; launcher menampilkan alamat API sebelum meminta persetujuan menjalankan worker.

Laptop baru: daftarkan nama laptop di website → unduh file koneksi → klik Impor koneksi pada launcher → pilih file JSON. Untuk perangkat lama yang kehilangan koneksi, tombol Buat koneksi baru mengganti token sebelumnya. Pembuatan ulang ditolak jika training sedang aktif.

Penghubung hanya didaftarkan pada akun Windows saat ini, tanpa admin. Jangan memindahkan folder setelah pemasangan. Panduan dan pembatasan ada di docs/WORKER-LAUNCHER.md. Menjalankan frontend/API lokal tetap menggunakan START-LOCAL.cmd atau npm run dev; jika website sudah dideploy, pengguna cukup memakai launcher.

## Jalankan di laptop ini

Dependensi, database khusus prototipe, akun lokal, dan worker sudah disiapkan.

1. Jalankan **START-LOCAL.cmd**. Ini menjalankan API port 3001 dan frontend port 5173; PostgreSQL prototipe port 55439.
2. Buka **http://127.0.0.1:5173**. Email dan kata sandi lokal ada di **.local/ACCESS.md**.
3. Jalankan **START-WORKER.cmd** di terminal terpisah.
4. Pastikan perangkat di website berstatus Online, lalu klik Mulai training.
5. Laporan JSON dapat diunduh melalui website. Model, checkpoint, CSV, dan ZIP berada di **worker/runs/<job-id>/**.

Jika proses yang sama sudah aktif, jangan menjalankan salinan kedua. START-LOCAL menampilkan log di .local; Enter menghentikan frontend/API yang dimulai launcher itu. Ctrl+C menghentikan worker. Menutup tab tidak menghentikan training. Biarkan laptop menyala, tidak sleep, dan tersambung jaringan saat menggunakan API cloud.

Tanpa Supabase Storage, model ZIP hanya berada di laptop. Status dan metrik tetap tersimpan di database. Dengan storage terkonfigurasi, worker mengunggah ZIP langsung ke bucket privat menggunakan URL bertanda tangan; tombol Model ZIP muncul setelah unggahan terverifikasi.

## Instalasi ulang / laptop lain

Prasyarat: Node.js 24 LTS, Python 3.12 + pip; untuk simulasi seluruh sistem lokal, PostgreSQL 16. GPU CUDA memerlukan driver NVIDIA yang sesuai. Mode CPU tersedia.

- Jalankan SETUP-LOCAL.cmd untuk npm ci, cluster PostgreSQL terisolasi, migrasi, akun admin lokal, dan konfigurasi worker.
- Lokasi PostgreSQL default: C:\Program Files\PostgreSQL\16\bin. Atur environment PG_BIN jika berbeda.
- Jalankan SETUP-WORKER.cmd untuk membuat lingkungan Python pada worker/.venv. Unduhan PyTorch CUDA dapat mencapai beberapa GB.
- Saat memakai website cloud, laptop **hanya** memerlukan worker Python. Node.js/PostgreSQL lokal tidak diperlukan.

SETUP-LOCAL tidak menimpa backend/.env, frontend/.env.local, atau worker/worker.json yang sudah ada. Jika beralih konfigurasi lokal/cloud, simpan cadangan berkas konfigurasi lalu pilih konfigurasi yang sesuai. Kredensial lokal dibuat acak dan tidak sama dengan akun EIS.

## Struktur

- frontend/src/services/api.ts — kontrak API, mengikuti pola VITE_API_BASE_URL pada EIS.
- frontend/src/App.tsx — login, eksperimen, perangkat dan riwayat.
- backend/src/app.ts — Express default export yang dideteksi Vercel; tanpa listener/worker latar.
- backend/src/local.ts — listener khusus pengembangan lokal.
- backend/src/routes, middleware, services, config, validator — pemisahan mengikuti backend EIS.
- backend/prisma — model dan migrasi PostgreSQL.
- worker/worker.py — polling API, heartbeat, klaim, progress, pembatalan, unggahan hasil.
- worker/trainer.py — training; titik penggantian dengan kode model sesungguhnya.
- docs/DEPLOYMENT.md — langkah deployment dua proyek Vercel.
- docs/ARCHITECTURE.md — kontrak, penyimpanan dan perilaku kegagalan.

## Verifikasi

Dari backend jalankan `npm test`. Tes dibatasi ke PostgreSQL lokal port 55439 dan hanya membuat/menghapus akun uji miliknya. Tes mencakup isolasi pengguna, klaim konkuren, heartbeat tidak berurutan, lease kedaluwarsa, cancel/claim race, completion idempotent dan pencabutan worker.

Build: `npm run build` masing-masing di frontend dan backend. Audit: `npm audit` di kedua folder.

Saat pembuatan: kedua build dan tes API lulus; npm audit tidak menemukan kerentanan. Training CUDA nyata 20 epoch melalui React → Express → PostgreSQL → worker laptop menghasilkan akurasi test 94,7% (seed 42). Ini hasil dataset demo, bukan metrik model EIS.

Deployment Vercel dan unggahan ke Supabase live belum diuji karena proyek cloud/kredensial prototipe belum dikonfigurasi. Jangan menganggap build lokal sebagai bukti deployment sukses.
