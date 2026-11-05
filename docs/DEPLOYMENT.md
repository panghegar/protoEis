# Deployment Vercel dengan training GPU laptop

Target: **dua proyek Vercel baru**, satu frontend dan satu backend; satu database PostgreSQL khusus prototipe. GPU tetap pada laptop. Jangan mengganti deployment atau memakai kredensial/database produksi EIS untuk pengujian ini.

## 1. Persiapan sumber

Simpan folder prototype sebagai repository sendiri, atau gunakan monorepo dengan Root Directory menunjuk subfolder yang tepat. Commit source dan package-lock.json. .gitignore mengecualikan .env, .local, worker.json, active.json, .venv, node_modules, hasil training, serta generated Prisma.

Jangan unggah seluruh folder laptop secara manual karena dapat menyertakan credential/data. File .env.example dan worker.example.json adalah template, bukan credential aktif.

## 2. Database dan akun

Buat database/proyek Supabase terpisah. DATABASE_URL backend menggunakan URL PostgreSQL pooler yang disarankan provider untuk serverless. DIRECT_URL dipakai Prisma CLI untuk migrasi melalui koneksi direct/session yang mendukung migrasi. Pertahankan validasi TLS sesuai konfigurasi provider; jangan menonaktifkan verifikasi sertifikat.

Untuk menerapkan migrasi dari terminal lokal, set DATABASE_URL dan DIRECT_URL pada environment proses menuju database **prototipe cloud**, lalu dari backend jalankan:

```powershell
npm ci
npm run db:deploy
```

Isi SEED_ADMIN_EMAIL dan SEED_ADMIN_PASSWORD pada environment terminal yang sama (kata sandi unik minimal 12 karakter), lalu jalankan `npm run seed`. Seed membuat akun baru saja; tidak mengubah password akun yang sudah ada. Hapus environment seed dari sesi sesudahnya. Jangan commit nilainya. Pastikan DIRECT_URL tidak masih menunjuk database lokal ketika melakukan migrasi cloud.

Migrasi menambahkan tabel User, Worker, Job dan mengaktifkan RLS. Gunakan database kosong khusus prototipe; nama tabel User dapat bertabrakan dengan skema EIS jika dipaksakan ke database yang sama. Tidak perlu memasukkan SEED_ADMIN_PASSWORD ke environment Vercel.

## 3. Backend Vercel

- Root Directory: **backend** (atau prototype/backend jika repo root berada di atas prototype).
- Node.js: **24.x**.
- Framework: deteksi **Express**.
- Install: npm ci. Build: npm run build.
- Jangan mengatur Output Directory menjadi dist sebagai website statis. Vercel mendeteksi default export Express di src/app.ts.
- Environment Production dan Preview yang relevan:
  - DATABASE_URL: URL koneksi database prototipe.
  - JWT_SECRET: secret acak minimal 32 karakter, berbeda dari lokal/EIS.
  - FRONTEND_ORIGINS: origin frontend yang persis, misalnya https://eis-training-demo.vercel.app; beberapa origin dipisah koma, tanpa slash penutup.
  - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_BUCKET jika fitur unduh model cloud diaktifkan.
- DIRECT_URL diperlukan pada lingkungan yang menjalankan migrasi; build hanya generate Prisma, tidak memodifikasi database.
- Deploy backend dan periksa GET https://BACKEND.vercel.app/api/health.
- Tes berikutnya harus berupa login dan GET /api/workers untuk memverifikasi koneksi database; health sendiri tidak membuktikan database berfungsi.

Proyek preview yang dilindungi Vercel Deployment Protection mungkin menolak worker sebelum JWT aplikasi diperiksa. Gunakan URL deployment yang memang dapat diakses worker atau konfigurasi mekanisme akses resmi Vercel secara terpisah. Jangan menganggap token worker otomatis melewati proteksi Vercel.

## 4. Frontend Vercel

- Root Directory: **frontend**.
- Framework: Vite. Install: npm ci. Build: npm run build. Output: dist.
- Environment: **VITE_API_BASE_URL=https://BACKEND.vercel.app/api**.
- Deploy. Bila URL frontend baru diketahui setelah deployment, masukkan URL persis itu pada FRONTEND_ORIGINS backend dan redeploy backend.
- VITE_API_BASE_URL ditanam saat build; perubahan memerlukan rebuild/redeploy frontend.
- vercel.json menyediakan fallback SPA agar /devices dapat dibuka langsung.

Tidak ada password, JWT_SECRET, token worker, atau service-role pada variabel VITE_*.

## 5. Storage model opsional

Buat bucket **training-artifacts** dengan status **private** di proyek Supabase prototipe. Untuk model demo tetapkan batas ukuran 50 MB dan tipe application/zip. Tidak perlu memberikan kebijakan publik untuk upload/download; backend membuat signed URL menggunakan credential server.

Isi environment storage pada backend lalu redeploy. Worker meminta upload ticket untuk tugas miliknya, mengunggah ZIP langsung ke Storage, dan melaporkan hasil. File ZIP tidak melewati body request Vercel. Tanpa storage, training dan laporan tetap berfungsi; model tersedia di folder laptop.

Unggahan demo memakai satu request dengan timeout 60 detik. Untuk model EIS besar, implementasikan resumable upload dan pengelolaan penyimpanan sesuai ukuran aktual. Jangan menjanjikan dukungan checkpoint besar dari pengujian demo ini.

## 6. Sambungkan laptop ke website online

1. Login ke frontend cloud menggunakan akun yang dibuat pada database cloud.
2. Buka Perangkat lokal → isi nama laptop → Daftarkan perangkat.
3. Klik Siapkan worker (Windows), ekstrak ZIP ke folder tetap, lalu buka INSTALL.cmd sekali. Python 3.12 dengan Tcl/Tk diperlukan. Pada launcher pilih Siapkan dependensi.
4. Unduh file koneksi dari website lalu pilih Impor koneksi pada launcher. Klik Jalankan worker di website dan izinkan browser membuka aplikasi; periksa alamat API pada konfirmasi launcher.
5. Pastikan perangkat muncul Online dan GPU terdeteksi.
6. Mulai training. Tutup tab lalu buka kembali untuk memastikan status tetap tersimpan.
7. Uji Hentikan training, Laporan JSON, dan Model ZIP jika Storage diaktifkan.
8. Putuskan koneksi worker untuk menguji status offline/interrupted dan memastikan tugas tidak dilatih ulang otomatis.

Laptop tidak perlu PostgreSQL, Node.js, server web lokal, public IP, atau port forwarding ketika berkomunikasi dengan deployment cloud. Tombol website membuka launcher yang sudah dipasang pada laptop pengguna; browser dapat meminta izin membuka aplikasi. Laptop harus menyala dan launcher harus berjalan. Panduan lengkap dan batas pengujian ada di WORKER-LAUNCHER.md.

## Bukti dan hal yang belum diverifikasi

Build frontend/backend, autentikasi dan antrean PostgreSQL, serta training CUDA sungguhan telah diuji lokal di laptop ini. Belum ada URL Vercel/Supabase prototipe yang dipasang dan belum ada verifikasi unggahan Storage live. Deployment selesai hanya setelah langkah 3–7 berhasil di akun cloud tujuan.

Referensi resmi:
- https://vercel.com/docs/frameworks/backend/express
- https://vercel.com/docs/frameworks/frontend/vite
- https://vercel.com/docs/functions/limitations
- https://supabase.com/docs/reference/javascript/storage-from-createsigneduploadurl
