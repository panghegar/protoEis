# CI/CD prototipe EIS

Workflow: `.github/workflows/ci-cd.yml`. Pengembangan dilakukan pada `dev`.

## Perilaku

| Kejadian | Pemeriksaan | Deployment production |
| --- | --- | --- |
| Push ke `dev` | Build frontend/backend, tes worker, launcher, dan API | Tidak |
| Pull request menuju `main` | Pemeriksaan kode gabungan PR | Tidak |
| Merge/push ke `main` | Semua pemeriksaan dijalankan lagi | Ya, jika CI lulus |
| Run workflow pada `main` | Semua pemeriksaan dijalankan lagi | Ya, jika CI lulus |
| Run workflow pada branch lain | Pemeriksaan | Tidak |

Urutan production: CI lulus, validasi konfigurasi, migrasi Supabase, deploy backend, lalu deploy frontend. Jika satu langkah gagal, langkah sesudahnya tidak dijalankan. Merge ke `main` menghasilkan event push. Push langsung ke `main` juga memicu deployment; gunakan aturan branch jika semua perubahan harus melalui PR.

CI memakai PostgreSQL 16 sementara pada `127.0.0.1:55439`, sesuai pengaman tes yang sudah ada. Kredensial CI hanyalah nilai fixture untuk container tersebut. Tes audio memakai Storage fixture lokal. Tidak ada secret Supabase/Vercel pada job pemeriksaan atau PR. CI tidak menjalankan training GPU, memasang PyTorch, atau menjalankan model Syafiq.

## Aktivasi satu kali

File workflow saja belum memberikan akses ke akun cloud. Setelah commit/push konfigurasi ini, isi secret berikut pada repository `panghegar/protoEis`: **Settings → Secrets and variables → Actions → New repository secret**.

| Secret GitHub Actions | Nilai dan sumber |
| --- | --- |
| `VERCEL_TOKEN` | Token dari https://vercel.com/account/tokens dengan akses ke proyek prototipe. Gunakan nama misalnya `proto-eis-github-actions`. |
| `VERCEL_ORG_ID` | Team/organization ID dari pengaturan akun/team Vercel yang memiliki kedua proyek. Bisa juga dilihat pada `orgId` di `.vercel/project.json` setelah proyek ditautkan melalui CLI. |
| `VERCEL_BACKEND_PROJECT_ID` | Project ID pada **Settings → General** proyek backend. |
| `VERCEL_FRONTEND_PROJECT_ID` | Project ID pada **Settings → General** proyek frontend. Harus berbeda dari backend. |
| `SUPABASE_MIGRATION_URL` | Connection string **database prototipe**, dari Supabase **Connect → Session pooler**, port `5432`, beserta password database yang sudah di-URL-encode bila diperlukan. Direct connection `5432` juga didukung jika dapat dijangkau runner. |

Secret GitHub dan environment variables Vercel adalah dua pengaturan terpisah. Jangan menyalin secret ke YAML atau commit file `.env`.

Pengaman workflow menolak URL migrasi lokal, domain selain endpoint Supabase, port selain `5432`, transaction pooling, atau SSL yang secara eksplisit dimatikan. Pemeriksaan format ini tidak dapat membuktikan bahwa project ref yang dimasukkan merupakan proyek prototipe yang benar; periksa project ref sebelum menyimpan secret.

### Pengaturan kedua proyek Vercel

- Keduanya berada pada team yang sama dengan `VERCEL_ORG_ID`.
- Backend: **Root Directory `backend`**, Node **24.x**, framework Express, install `npm ci`, build `npm run build`.
- Frontend: **Root Directory `frontend`**, Node **24.x**, framework Vite, install `npm ci`, build `npm run build`, output `dist`.
- Bila memakai Git integration, Production Branch tetap `main`.
- `git.deploymentEnabled: false` pada kedua `vercel.json` mematikan deployment Git otomatis. Workflow ini mengambil alih deployment melalui Vercel CLI setelah CI lulus, sehingga tidak ada deployment Git yang berlomba dengan CI. CLI/manual deployment tetap dapat dipakai.
- Jika sudah ada Deploy Hook atau workflow deployment lain, nonaktifkan pemicunya agar tidak terjadi deployment ganda.

Workflow CLI dijalankan dari root repository. Vercel memakai Root Directory milik masing-masing proyek. Jangan mengganti working directory langkah deploy menjadi `backend`/`frontend` sambil mempertahankan root setting yang sama tanpa menyesuaikan prosesnya.

Kode dibangun kembali di Vercel dengan environment **Production** yang tersimpan pada proyek tersebut. CI memakai URL frontend fixture dan tidak menghasilkan deployment untuk `dev`/PR. ZIP worker dibentuk ulang dari allowlist sumber setiap CI dan deployment, sehingga unduhan frontend mengikuti commit yang dideploy. Versi CLI dikunci pada `vercel@67.0.0`; pembaruannya dilakukan secara terencana.

Environment backend yang tetap diperlukan: `DATABASE_URL`, `JWT_SECRET`, `FRONTEND_ORIGINS`, serta konfigurasi Storage/cleanup bila fitur tersebut digunakan. Environment frontend tetap `VITE_API_BASE_URL` yang menunjuk **domain production backend yang stabil**, berakhiran `/api`, bukan URL deployment sementara. Lihat `DEPLOYMENT.md` dan `BIRD-AUDIO.md`.

Migrasi production dijalankan oleh GitHub Actions sebelum deploy, menggunakan `SUPABASE_MIGRATION_URL` untuk `DATABASE_URL` dan `DIRECT_URL` pada langkah itu saja. Build Vercel hanya generate Prisma dan compile kode. Workflow tidak melakukan seed admin, reset database, upload dataset, penyiapan bucket, ataupun pemasangan Cron. Bucket privat dan Cron yang sudah disiapkan tetap dipakai. Bootstrap cloud baru tetap memerlukan panduan setup terkait.

### Aturan branch yang disarankan

Pada GitHub **Settings → Rules → Rulesets** atau Branch protection, jika tersedia untuk paket/visibilitas repo:

1. Targetkan `main`.
2. Wajibkan pull request sebelum merge.
3. Wajibkan status check **CI passed**. Jalankan CI sekali agar nama check muncul.
4. Jika diperlukan, wajibkan branch PR sudah mengikuti `main` terbaru.

Ini saran konfigurasi akun dan belum diterapkan oleh penambahan file workflow. Tidak perlu memasang aturan approval manual production jika ingin deploy langsung setelah merge.

## Alur harian

```bash
git switch dev
# edit kode dan periksa perubahan
git add <file-yang-diubah>
git commit -m "feat: uraian perubahan"
git push -u origin dev
```

Buat PR `dev → main`, tunggu **CI passed**, lalu merge. Buka tab **Actions → CI / CD** untuk melihat job **Deploy production** dan URL hasilnya. CLI menunggu build backend selesai sebelum mulai deploy frontend. URL deployment tidak menggantikan domain production stabil yang sudah digunakan pada konfigurasi frontend/worker.

Jika deployment gagal setelah merge, perbaiki penyebabnya lalu pilih **Re-run failed jobs** pada run terkait atau jalankan **Run workflow** pada `main`. Workflow production tidak dibatalkan otomatis ketika ada commit baru agar migrasi tidak diputus di tengah jalan. GitHub dapat mengganti run pending dengan run lebih baru; yang sedang berjalan dibiarkan selesai.

## Troubleshooting

| Gejala | Pemeriksaan |
| --- | --- |
| Secret belum lengkap | Job deployment menyebut nama secret yang perlu diisi, tanpa menampilkan nilainya. |
| Migrasi masih menuju localhost | Pastikan secret `SUPABASE_MIGRATION_URL` berisi session/direct URL cloud, bukan `.env` lokal. |
| P1001 | Periksa host, jaringan, project Supabase aktif, dan mode koneksi; session pooler IPv4 dapat dipakai. |
| Token/proyek Vercel ditolak | Periksa token, pemilik/team, kedua Project ID, dan Root Directory. |
| Frontend tidak dapat login | Periksa `VITE_API_BASE_URL`, `FRONTEND_ORIGINS`, akun cloud, dan koneksi database. |
| Deploy ganda | Periksa `git.deploymentEnabled` dan pemicu Deploy Hook lain. |
| Worker tidak ikut berubah di laptop client | Deploy memperbarui ZIP unduhan website; client tetap perlu memperbarui instalasinya. |

Tes CI tidak membuktikan CORS, bucket, jaringan, URL production, atau launcher GUI telah bekerja di lingkungan live. Sesudah deployment pertama, uji login, worker Online, unggah WAV kecil, pembatalan, hasil, dan XLSX. Endpoint health saja tidak membuktikan akses database atau model berhasil.

Migrasi yang sudah berhasil tidak di-rollback otomatis apabila build/deploy gagal setelahnya. Tulis migrasi yang kompatibel dengan versi aplikasi sebelumnya dan periksa backup sebelum perubahan yang menghapus data.

## Referensi

- https://vercel.com/docs/cli/deploy
- https://vercel.com/docs/project-configuration/git-configuration
- https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers
- https://docs.prisma.io/docs/cli/migrate/deploy
