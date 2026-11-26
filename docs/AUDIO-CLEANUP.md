# Pembersihan audio bulanan

Status penyesuaian 26 November 2026: penjadwalan otomatis hanya memakai
**Vercel Cron**. Task Windows yang sempat dibuat sudah dihapus, beserta installer
dan runner penjadwal laptop. Konfigurasi Vercel dan CI/CD tersedia di branch
`dev`; jadwal online aktif setelah deployment Production berhasil.

Keputusan pengguna pada 26 November 2026: hapus audio yang sudah kedaluwarsa;
pertahankan audio baru dan pekerjaan yang masih diproses. Penghapusan hanya
menyasar potongan audio pada bucket privat `SUPABASE_AUDIO_BUCKET` yang tercatat
di database backend. Hasil identifikasi, XLSX, model, ZIP sumber, dan rekaman asli
di laptop tidak dihapus oleh pekerjaan ini.

## Jadwal dan retensi

- Bulanan: tanggal **1 sekitar pukul 00.00 WIB**.
- Aturan kedaluwarsa tetap **24 jam setelah pekerjaan selesai/gagal/dibatalkan**.
  Unggahan/antrean yang tidak selesai mengikuti batas 24 jam sejak dibuat.
- Pembersihan saat website membaca riwayat atau menerima unggahan baru tetap
  berjalan. Jadwal bulanan tidak mengubah retensi menjadi 30 hari.
- Pekerjaan berstatus `running` dilewati. Lease yang sudah terputus ditangani
  melalui aturan `interrupted`, dengan retensi baru 24 jam.
- Catatan yang sudah pernah dihapus juga diaudit pada pembersihan bulanan untuk
  menangani potongan unggahan yang terlambat tiba.
- File yang tidak memiliki catatan pada database tersebut tidak dihapus secara
  membabi buta. Perbedaan database lokal/cloud perlu diperhatikan saat mengaudit
  file yang tampak tertinggal pada bucket yang sama.

## Website online: Vercel Cron

`backend/vercel.json` memanggil `/api/internal/audio-cleanup/monthly` pada
`0 17 28-31 * *` (UTC). Pukul 17.00 UTC adalah pukul 00.00 WIB pada hari berikutnya.
Karena hari terakhir bulan dapat tanggal 28, 29, 30, atau 31, endpoint memeriksa
kalender `Asia/Jakarta`: pembersihan hanya dijalankan pada tanggal 1. Panggilan
pada tanggal lainnya berhenti dengan status `skipped` tanpa memanggil penghapusan.
Dengan cara ini pergantian tahun dan Februari tahun kabisat tetap ditangani.

Pada Vercel Hobby, jadwal pukul 00.00 dapat dipanggil pada rentang 00.00–00.59 WIB;
pelaksanaan persis pada menit 00.00 tidak dijamin. Pemeriksaan tanggal menerima
seluruh tanggal 1 sehingga pelaksanaan yang terlambat pada hari itu tetap valid.
Untuk pengulangan manual di luar tanggal 1, gunakan endpoint terautentikasi
`/api/internal/audio-cleanup` atau CLI. Retensi dan perlindungan audio aktif tetap
berlaku.

Cron hanya berjalan pada deployment **Production**. Merge/push ke `main` melalui
CI/CD diperlukan untuk mengaktifkan konfigurasi baru ini; perubahan pada `dev`
atau Preview tidak mengaktifkannya.

Workflow `CI / CD` menyiapkan `CRON_SECRET` pada proyek **backend Production**
melalui `scripts/ensure-cron-secret.mjs`. Secret dibuat acak bila belum ada,
disimpan terenkripsi pada Vercel, dan nilainya tidak dicetak atau dimasukkan Git.
Secret yang sudah ada dipertahankan. Lima repository secrets sebelumnya tetap
digunakan; tidak ada repository secret baru. Token Vercel harus memiliki akses
membaca/mengatur environment backend. Jika akses ditolak, deployment dihentikan
dengan pesan tanpa menampilkan nilai secret.

Untuk deploy manual di luar workflow, isi `CRON_SECRET` acak minimal 32 karakter
pada environment Production backend, kemudian deploy. Vercel mengirimkannya
melalui `Authorization: Bearer ...`. Endpoint menolak permintaan tanpa secret
yang benar. Jangan menaruh secret pada frontend atau parameter URL.

Setelah deployment, periksa **Schedules → Cron Jobs** dan log eksekusi. Kode
respons 200 berarti seluruh audio yang memenuhi syarat selesai diperiksa.
Respons 503 dengan `pending`/`remaining` berarti masih ada pekerjaan atau
kegagalan yang perlu dicoba ulang; jangan menganggapnya sudah bersih. Vercel
tidak menjamin percobaan ulang otomatis ketika Cron gagal, jadi periksa log dan
jalankan ulang dari dashboard jika diperlukan.

## Database cloud dan pengujian lokal

Vercel menjalankan cron tanpa bergantung pada laptop. Backend Production harus
menggunakan database Supabase yang memuat catatan `Job`, waktu kedaluwarsa, dan
lokasi potongan audio pada Storage. Identifikasi tetap dapat dikerjakan worker
laptop; penjadwalan pembersihan dikerjakan Vercel.

Tidak ada penjadwal otomatis pada Windows dan tidak ada runner yang menyalakan
database laptop untuk keperluan cron. Data atau konfigurasi lokal tidak dipindah
ke cloud secara otomatis melalui perubahan ini.

Audio uji yang hanya tercatat pada PostgreSQL lokal tidak dapat ditemukan oleh
cron Production, meskipun file berada pada bucket Supabase yang sama. Untuk
memasukkan audio baru ke alur pembersihan cloud, buat tugas melalui backend
online agar metadatanya tersimpan pada database Supabase. Data uji lokal lama
dapat diperiksa dan dibersihkan secara manual; jangan menganggapnya sudah
tercakup hanya karena file berada pada Storage cloud.

Perintah administrasi berikut bersifat **manual**, dijalankan dari direktori
`backend` terhadap database pada environment yang dipilih operator:

```powershell
npm run bird:cleanup:preview
```

Untuk menghapus audio kedaluwarsa setelah memeriksa environment dan pratinjau:

```powershell
npm run bird:cleanup
```

Perintah tersebut bukan cron, tidak didaftarkan ke Task Scheduler, dan tidak
dijalankan otomatis pada laptop. Riwayat log lokal yang sudah ada dipertahankan.

## Batas pelaksanaan dan pengujian

Pembersihan mengunci catatan yang memenuhi syarat sebelum mengubah unggahan atau
antrean kedaluwarsa menjadi gagal. Setelah itu, file dihapus melalui Storage API,
bukan melalui penghapusan SQL pada tabel internal Storage. Satu permintaan
Storage mencakup maksimal 25 pekerjaan / 875 potongan, dan proses berlanjut ke
batch berikutnya. Kegagalan tetap bisa dicoba ulang; hasil identifikasi dipertahankan.

Endpoint online memiliki budget proses 45 detik dengan batas fungsi 60 detik.
CLI memiliki budget 5 menit. Batas 10.000 catatan per pelaksanaan mencegah satu
pekerjaan tanpa batas. `remaining` mengungkap pekerjaan yang belum selesai,
termasuk catatan sedang terkunci. Penghapusan berulang bersifat idempotent.
Estimasi byte yang dibebaskan berasal dari metadata aplikasi, bukan pembacaan
tagihan atau penggunaan total Storage.

Tes otomatis memakai database uji terpisah dan Storage fixture, mencakup preview,
lebih dari 10 audio, beberapa batch, audio baru/aktif, catatan terkunci, retry,
unggahan terlambat, autentikasi cron, dan hasil yang tetap tersedia. Pemeriksaan
konfigurasi CI tidak memakai token cloud asli atau melakukan penghapusan live.

## Menghemat kapasitas 1 GB

1. Bulanan saja bisa terlambat bila rekaman sering masuk. Pertimbangkan jadwal
   harian dengan retensi 24 jam setelah kebutuhan arsip disepakati.
2. Simpan arsip WAV asli pada perangkat/penyimpanan EIS. Supabase dipakai sebagai
   tempat transfer sementara, sementara tabel hasil dapat dipertahankan.
3. MP3 biasanya lebih kecil. Uji dampaknya terhadap hasil model bersama Syafiq
   sebelum menjadikannya format utama. Jangan menganggap kompresi selalu tanpa
   pengaruh terhadap prediksi.
4. Hindari unggahan duplikat. Checksum yang ada memvalidasi transfer; fitur reuse
   file berdasarkan checksum belum diimplementasikan sebagai deduplikasi Storage.
5. Pantau penggunaan total pada dashboard Supabase dan sisakan ruang bagi file
   lain. Pembagian file menjadi potongan 20 MiB mengatasi batas per file; total
   ukuran audio tetap menghabiskan kapasitas yang sama.

Referensi resmi:

- [Vercel Cron usage](https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing)
- [Vercel Cron authentication](https://vercel.com/docs/schedules/cron-jobs/manage-cron-jobs)
- [Vercel environment API](https://vercel.com/docs/rest-api/projects/create-one-or-more-environment-variables)
- [Supabase Storage usage](https://supabase.com/docs/guides/platform/manage-your-usage/storage-size)
