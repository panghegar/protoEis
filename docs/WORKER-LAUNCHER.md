# Launcher worker Windows

## Alur pengguna

1. Buka Perangkat lokal pada website.
2. Siapkan worker (Windows) mengunduh eis-worker-windows.zip dari frontend. Ekstrak ke folder tetap dan buka INSTALL.cmd sekali. Python 3.12 dengan Tcl/Tk diperlukan; installer memberi petunjuk jika belum tersedia.
3. Pada launcher pilih Siapkan dependensi untuk memasang PyTorch CUDA, NumPy, dan scikit-learn. Proses ditampilkan di jendela launcher; unduhan awal dapat beberapa GB.
4. Daftarkan laptop pada website dan unduh file koneksi. Pada launcher pilih Impor koneksi dan periksa alamat API sebelum menyetujui.
5. Klik Jalankan worker di website. Browser dapat meminta izin membuka aplikasi. Launcher memeriksa ID perangkat dan menampilkan konfirmasi sebelum memulai worker.
6. Status Online hanya muncul setelah heartbeat diterima backend, bukan hanya karena tombol diklik.
7. Hentikan worker melalui launcher. Training aktif menerima pembatalan dan menyimpan hasil parsial. Status website dapat memerlukan sampai 45 detik untuk berubah Offline.

Untuk laptop pengembangan ini: launcher telah terdaftar dari folder worker proyek dan dapat memakai .venv serta worker.json yang sudah ada. Tidak perlu setup atau unduh ulang.

## Yang berlangsung di laptop

- Registrasi per pengguna: HKCU/Software/Classes/eisworker. Tidak mengubah pengaturan keamanan browser atau membuka port lokal.
- Handler memanggil pythonw.exe dan launcher.py dengan argumen URI. Tidak memakai shell/eval untuk mengeksekusi isi URI.
- URI hanya boleh berbentuk eisworker://start/UUID. Query, fragment, perintah, token, serta path arbitrer ditolak.
- ID pada URI harus sama dengan ID dalam koneksi lokal. Token hanya dibaca dari worker.json; tidak ditempelkan pada URL.
- File koneksi diimpor melalui dialog lokal dan ditampilkan alamat tujuannya. Import dan setup dinonaktifkan ketika worker berjalan.
- Worker dijalankan sebagai proses tersembunyi; jendela launcher menampilkan status. worker.stop menjadi permintaan berhenti kooperatif pada loop worker/trainer. Log ada di launcher-worker.log.
- Setup hanya memasang paket tetap dari PyTorch official index dan PyPI; paket remote tidak dipilih dari query URL.
- Membuka launcher tidak otomatis mengunduh dependensi, mengganti konfigurasi, atau menjalankan training baru. Persetujuan dan tombol terkait tetap diperlukan.

## Pembatasan

Saat ini Windows + Python 3.12 diperlukan. Ini paket source launcher, belum installer EXE bertanda tangan atau Python runtime mandiri. Browser tidak bisa memasang program diam-diam. Browser tertanam dapat menolak pembukaan protokol aplikasi; pengguna dapat membuka BUKA-LAUNCHER.cmd sebagai jalur manual.

Handler eisworker hanya menunjuk satu folder instalasi per akun Windows. Installer menolak menimpa handler dari folder berbeda. Untuk berpindah folder, lepaskan handler melalui UNINSTALL-LAUNCHER.py milik instalasi lama, lalu pasang dari folder baru. Data dan environment tidak dihapus oleh pelepasan handler.

Tombol membuka launcher pada komputer tempat browser digunakan; tidak menyalakan laptop lain secara jarak jauh. Jangan membagikan token. Tombol Buat koneksi baru mengganti token sebelumnya dan ditolak saat job running.

## Paket untuk deployment

Jalankan dari root proyek:

```powershell
python scripts/package-worker.py
python scripts/test-launcher.py
```

Paket menggunakan daftar file eksplisit. File worker.json, .venv, database, dataset pengguna, runs, dan log tidak disertakan. Commit frontend/public/downloads/eis-worker-windows.zip serta worker-release.json setelah perubahan worker/launcher. Paket statis dapat diunduh dari frontend Vercel; rewrite SPA mengecualikan downloads/.

## Verifikasi

Build frontend/backend dan tes API lulus. Tes Python memeriksa penolakan URI/perintah berbahaya, pencocokan perangkat, validasi koneksi, isi ZIP identik dengan source dan tidak mengandung credential. Tes API mencakup rotasi token milik pengguna, penolakan token lama, dan penolakan rotasi ketika training aktif.

Registrasi handler Windows berhasil pada laptop ini. Browser pengujian memblokir navigasi protokol aplikasi; pembukaan GUI melalui klik browser dan alur GUI setup/import/start belum terverifikasi end-to-end secara otomatis. Pengguna perlu mencoba tombol di browser Windows yang mendukung protokol aplikasi. Pemeriksaan kode dan build bukan bukti bahwa setiap browser pasti membuka launcher.

Referensi:
- https://learn.microsoft.com/en-us/windows/apps/develop/launch/launch-default-app
- https://learn.microsoft.com/en-us/windows/win32/shell/app-registration
