"""EIS Worker Launcher: Tk GUI for setup, connection import and worker control."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import filedialog,messagebox,ttk
from launcher_core import WorkerControl,config_worker_id,import_config,parse_start_uri,read_config,setup_commands,venv_python

ROOT=Path(__file__).resolve().parent
class Launcher:
    def __init__(self,window,expected_id=None):
        self.window=window
        self.expected_id=expected_id
        self.control=WorkerControl(ROOT)
        self.events=queue.Queue()
        self.installing=False
        self.closing=False
        window.title('EIS Worker — Laptop Lokal')
        window.geometry('730x590')
        window.minsize(650,520)
        window.configure(bg='#f5f7f2')
        ttk.Style().theme_use('clam')
        frame=ttk.Frame(window,padding=24)
        frame.pack(fill='both',expand=True)
        ttk.Label(frame,text='EIS Worker',font=('Segoe UI',22,'bold')).pack(anchor='w')
        ttk.Label(frame,text='Hubungkan laptop Anda. Training dan identifikasi audio berjalan di laptop.',wraplength=660).pack(anchor='w',pady=(5,16))
        self.connection=tk.StringVar()
        self.state=tk.StringVar(value='Memeriksa perangkat…')
        ttk.Label(frame,textvariable=self.connection,wraplength=660).pack(anchor='w',pady=5)
        ttk.Label(frame,textvariable=self.state,font=('Segoe UI',11,'bold'),wraplength=660).pack(anchor='w',pady=10)
        row=ttk.Frame(frame);row.pack(fill='x',pady=10)
        self.setup=ttk.Button(row,text='1. Siapkan dependensi',command=self.install)
        self.setup.pack(side='left',padx=(0,8))
        self.connect=ttk.Button(row,text='2. Impor koneksi',command=self.choose_config)
        self.connect.pack(side='left',padx=(0,8))
        self.start_button=ttk.Button(row,text='3. Jalankan worker',command=self.start)
        self.start_button.pack(side='left')
        self.stop_button=ttk.Button(frame,text='Hentikan worker',command=self.stop)
        self.stop_button.pack(anchor='w',pady=(0,12))
        self.bar=ttk.Progressbar(frame,mode='indeterminate');self.bar.pack(fill='x',pady=8)
        ttk.Label(frame,text='Aktivitas',font=('Segoe UI',10,'bold')).pack(anchor='w')
        self.log=tk.Text(frame,height=12,wrap='word',font=('Consolas',9),bg='#ffffff',state='disabled')
        self.log.pack(fill='both',expand=True,pady=8)
        ttk.Label(frame,text='Biarkan jendela ini terbuka. Status Online dapat dilihat pada website.\nSetup pertama memerlukan internet dan ruang disk beberapa GB.',wraplength=660).pack(anchor='w')
        self.update_connection()
        window.protocol('WM_DELETE_WINDOW',self.close)
        window.after(300,self.poll)
        if expected_id: window.after(500,self.protocol_start)

    def write(self,text):
        self.log.configure(state='normal')
        self.log.insert('end',text.rstrip()+'\n')
        if int(self.log.index('end-1c').split('.')[0])>350:
            self.log.delete('1.0','100.0')
        self.log.see('end');self.log.configure(state='disabled')

    def update_connection(self):
        try:
            config=read_config(ROOT/'worker.json')
            self.connection.set('Terhubung ke: '+config['apiUrl']+'\nID perangkat: '+config_worker_id(config))
        except (OSError,ValueError):
            self.connection.set('Belum ada koneksi. Unduh koneksi dari halaman Perangkat lokal, lalu klik Impor koneksi.')

    def choose_config(self):
        if self.control.running():
            messagebox.showinfo('Worker masih aktif','Hentikan worker sebelum mengganti koneksi.',parent=self.window);return
        source=filedialog.askopenfilename(title='Pilih file koneksi dari website EIS',filetypes=[('Koneksi worker','*.json')],parent=self.window)
        if not source:return
        try:
            config=read_config(Path(source))
            if self.expected_id and config_worker_id(config)!=self.expected_id:
                raise ValueError('File koneksi berbeda dari perangkat pada tombol website.')
            if not messagebox.askyesno('Hubungkan laptop','Izinkan laptop mengambil tugas training dari:\n'+config['apiUrl']+'\n\nKonfigurasi lama, jika ada, akan diganti.',parent=self.window):return
            import_config(Path(source),ROOT)
            self.update_connection()
            self.write('Koneksi berhasil diimpor. Token tidak ditampilkan.')
        except (OSError,ValueError) as exc:
            messagebox.showerror('Koneksi tidak berhasil',str(exc),parent=self.window)

    def install(self):
        if self.installing or self.control.running():return
        if not messagebox.askyesno('Siapkan dependensi','Pasang atau periksa PyTorch dan dependensi worker dari registry resmi?\n\nUnduhan pertama dapat mencapai beberapa GB. Proses bisa memerlukan beberapa menit.',parent=self.window):return
        self.installing=True;self.bar.start()
        self.write('Memulai persiapan lingkungan Python lokal…')
        def run():
            try:
                for command in setup_commands(ROOT):
                    process=subprocess.Popen(command,cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,
                        text=True,encoding='utf-8',errors='replace',creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
                    for line in process.stdout:
                        self.events.put(('log',line))
                    if process.wait()!=0:
                        raise RuntimeError('Instalasi belum berhasil. Periksa pesan di atas, Python/pip, dan koneksi internet; lalu coba lagi.')
                self.events.put(('done','Dependensi siap. Impor koneksi lalu jalankan worker.'))
            except Exception as exc:self.events.put(('error',str(exc)))
        threading.Thread(target=run,daemon=True).start()

    def protocol_start(self):
        try:
            config=read_config(ROOT/'worker.json')
            if config_worker_id(config)!=self.expected_id:
                raise ValueError('Koneksi laptop belum cocok. Impor file koneksi untuk perangkat yang Anda pilih di website.')
            if self.control.running():
                self.write('Worker sudah berjalan. Periksa status Online di website.');return
            if messagebox.askyesno('Jalankan worker lokal','Jalankan worker untuk mengambil tugas dari:\n'+config['apiUrl']+'\n\nLaptop akan menggunakan GPU/CPU untuk tugas yang Anda antrekan.',parent=self.window):
                self.start()
        except (OSError,ValueError) as exc:
            messagebox.showinfo('Hubungkan perangkat terlebih dahulu',str(exc),parent=self.window)

    def start(self):
        if self.installing:return
        try:
            started=self.control.start(self.expected_id)
            self.write('Worker dimulai. Tunggu status Online di website.' if started else 'Worker sudah berjalan dari folder ini.')
        except (OSError,ValueError) as exc:
            messagebox.showerror('Worker belum bisa dimulai',str(exc),parent=self.window)

    def stop(self):
        self.control.stop()
        self.write('Meminta worker berhenti dengan aman; tunggu proses aktif menyimpan hasil.')

    def poll(self):
        try:
            while True:
                kind,text=self.events.get_nowait()
                self.write(text)
                if kind in ('done','error'):
                    self.installing=False;self.bar.stop()
        except queue.Empty:pass
        running=self.control.running()
        if self.installing:self.state.set('Sedang menyiapkan dependensi…')
        elif self.closing:self.state.set('Menunggu worker berhenti…')
        elif running:self.state.set('Worker aktif di laptop. Periksa koneksi Online pada website.')
        elif self.control.process is not None and self.control.process.returncode not in (None,0):
            self.state.set('Worker berhenti dengan kesalahan. Periksa launcher-worker.log di folder worker.')
        else:self.state.set('Siap dijalankan.' if venv_python(ROOT).exists() else 'Dependensi belum terpasang. Mulai dari langkah 1.')
        for button in (self.setup,self.connect):
            button.configure(state='disabled' if self.installing or running else 'normal')
        self.start_button.configure(state='disabled' if self.installing or running else 'normal')
        self.stop_button.configure(state='normal' if running else 'disabled')
        if self.closing and not running:
            self.window.destroy();return
        self.window.after(1000,self.poll)

    def close(self):
        if self.installing:
            messagebox.showinfo('Persiapan berlangsung','Tunggu persiapan dependensi selesai sebelum menutup launcher.',parent=self.window);return
        if self.control.running():
            if not messagebox.askyesno('Hentikan worker?','Menutup launcher akan meminta worker berhenti. Training aktif akan dibatalkan dengan menyimpan hasil parsial.',parent=self.window):return
            self.closing=True;self.stop()
        else:self.window.destroy()

def main():
    expected_id=None
    try:
        if len(sys.argv)>2:raise ValueError('Argumen launcher tidak valid.')
        if len(sys.argv)==2:expected_id=parse_start_uri(sys.argv[1])
    except ValueError as exc:
        root=tk.Tk();root.withdraw()
        messagebox.showerror('Tautan tidak valid',str(exc),parent=root)
        root.destroy();return
    window=tk.Tk()
    Launcher(window,expected_id)
    window.mainloop()

if __name__=='__main__':main()
