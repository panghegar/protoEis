import winreg
from pathlib import Path
import tkinter as tk
from tkinter import messagebox
root=tk.Tk();root.withdraw()
key=r'Software\Classes\eisworker'
try:
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER,key+r'\shell\open\command') as current:
        command=winreg.QueryValueEx(current,'')[0]
    if str(Path(__file__).resolve().parent/'launcher.py') not in command:
        raise RuntimeError('Handler terdaftar dari folder lain; tidak diubah.')
    if messagebox.askyesno('Lepaskan launcher','Hapus penghubung tombol website untuk launcher ini?\nDataset dan hasil training tetap disimpan.',parent=root):
        for suffix in (r'\shell\open\command',r'\shell\open',r'\shell',''):
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER,key+suffix)
        messagebox.showinfo('Selesai','Penghubung launcher dilepas.',parent=root)
except FileNotFoundError:messagebox.showinfo('Tidak terpasang','Launcher ini belum terdaftar.',parent=root)
except Exception as exc:messagebox.showerror('Tidak dapat dilepas',str(exc),parent=root)
root.destroy()
