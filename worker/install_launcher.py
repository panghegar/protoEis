"""Registers only this user's eisworker URI handler, without admin rights."""
import os
from pathlib import Path
import subprocess
import sys
import tkinter as tk
from tkinter import messagebox

ROOT=Path(__file__).resolve().parent
KEY=r'Software\Classes\eisworker'
def register():
    if os.name!='nt':raise RuntimeError('Installer ini khusus Windows.')
    if sys.version_info[:2]!=(3,12):raise RuntimeError('Gunakan Python 3.12 untuk paket worker ini.')
    import winreg
    pythonw=Path(sys.executable).with_name('pythonw.exe')
    if not pythonw.exists():raise RuntimeError('pythonw.exe tidak ditemukan. Perbaiki instalasi Python 3.12.')
    command='"'+str(pythonw)+'" "'+str(ROOT/'launcher.py')+'" "%1"'
    # Never overwrite a different installation silently.
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,KEY+r'\shell\open\command') as existing:
            previous=winreg.QueryValueEx(existing,'')[0]
        if previous!=command:raise RuntimeError('Launcher sudah terdaftar dari folder lain. Lepaskan launcher lama terlebih dahulu, lalu pasang dari folder ini.')
    except FileNotFoundError:pass
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER,KEY) as key:
        winreg.SetValueEx(key,'',0,winreg.REG_SZ,'URL:EIS Worker')
        winreg.SetValueEx(key,'URL Protocol',0,winreg.REG_SZ,'')
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER,KEY+r'\shell\open\command') as key:
        winreg.SetValueEx(key,'',0,winreg.REG_SZ,command)
    return pythonw

def main():
    root=tk.Tk();root.withdraw()
    try:
        pythonw=register()
        messagebox.showinfo('Launcher siap','Launcher EIS terpasang untuk akun Windows ini.\n\nPada launcher: siapkan dependensi jika belum ada, lalu impor file koneksi dari website. Jangan memindahkan folder launcher setelah dipasang.',parent=root)
        subprocess.Popen([str(pythonw),str(ROOT/'launcher.py')],cwd=ROOT,creationflags=subprocess.CREATE_NO_WINDOW)
    except Exception as exc:
        messagebox.showerror('Pemasangan belum berhasil',str(exc),parent=root)
    finally:root.destroy()
if __name__=='__main__':
    if sys.argv[1:]==['--register-only']:
        register()
        print('Launcher terdaftar untuk akun Windows saat ini.')
    else:main()
