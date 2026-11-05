"""Local-only launcher operations. URI input never becomes a command or a path."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import urlsplit
from uuid import UUID

SCHEME = 'eisworker'
TOKEN = re.compile(r'([a-f0-9-]{36})\.([a-f0-9]{64})', re.I)

def parse_start_uri(uri):
    if not isinstance(uri,str) or len(uri)>100:
        raise ValueError('Tautan launcher tidak valid.')
    match=re.fullmatch(r'eisworker://start/([a-f0-9-]{36})/?',uri,re.I)
    if not match:
        raise ValueError('Launcher hanya menerima tautan untuk menjalankan perangkat terdaftar.')
    return str(UUID(match[1]))

def validate_config(raw):
    if not isinstance(raw,dict) or set(raw)!={'apiUrl','token'}:
        raise ValueError('File koneksi harus berisi apiUrl dan token.')
    base=raw['apiUrl']
    if not isinstance(base,str) or len(base)>500:
        raise ValueError('Alamat API tidak valid.')
    parsed=urlsplit(base)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('Alamat API tidak boleh berisi kredensial, query, atau fragment.')
    if not parsed.hostname or not parsed.path.rstrip('/').endswith('/api'):
        raise ValueError('Alamat API harus diakhiri /api.')
    if parsed.scheme!='https' and not (parsed.scheme=='http' and parsed.hostname in ('127.0.0.1','localhost')):
        raise ValueError('API harus HTTPS, kecuali localhost.')
    match=TOKEN.fullmatch(raw['token']) if isinstance(raw['token'],str) else None
    if not match:
        raise ValueError('Token perangkat tidak valid.')
    UUID(match[1])
    return {'apiUrl':base.rstrip('/'),'token':raw['token']}

def read_config(path):
    if path.stat().st_size>4096:
        raise ValueError('File koneksi terlalu besar.')
    return validate_config(json.loads(path.read_text(encoding='utf-8-sig')))

def config_worker_id(config):
    return str(UUID(config['token'].split('.')[0]))

def import_config(source,root):
    config=read_config(source)
    target=root/'worker.json'
    temporary=root/'worker.json.new'
    temporary.write_text(json.dumps(config,indent=2),encoding='utf-8')
    os.replace(temporary,target)
    return config

def python_console():
    path=Path(sys.executable)
    if os.name=='nt' and path.name.lower()=='pythonw.exe':
        return str(path.with_name('python.exe'))
    return str(path)

def venv_python(root):
    return root/'.venv'/('Scripts/python.exe' if os.name=='nt' else 'bin/python')

def setup_commands(root):
    py=python_console()
    venv=str(venv_python(root))
    commands=[]
    if not Path(venv).exists():
        commands.append([py,'-m','venv','--without-pip',str(root/'.venv')])
    commands.extend([
        [py,'-m','pip','--python',venv,'install','torch==2.9.1','--index-url','https://download.pytorch.org/whl/cu126'],
        [py,'-m','pip','--python',venv,'install','-r',str(root/'requirements.txt')],
        [venv,'-c','import torch, sklearn, numpy; print("Siap:", torch.__version__, "| GPU:", torch.cuda.get_device_name(0) if torch.cuda.is_available() else "CPU")'],
    ])
    return commands

def worker_running(root):
    path=root/'worker.lock'
    if not path.exists(): return False
    try:
        with path.open('r+b') as handle:
            if os.name=='nt':
                import msvcrt
                handle.seek(0)
                try: msvcrt.locking(handle.fileno(),msvcrt.LK_NBLCK,1)
                except OSError: return True
                msvcrt.locking(handle.fileno(),msvcrt.LK_UNLCK,1)
            else:
                import fcntl
                try: fcntl.flock(handle.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
                except OSError: return True
                fcntl.flock(handle.fileno(),fcntl.LOCK_UN)
        return False
    except OSError:
        return True

class WorkerControl:
    def __init__(self,root):
        self.root=root.resolve()
        self.process=None
        self.log_handle=None

    def running(self):
        return (self.process is not None and self.process.poll() is None) or worker_running(self.root)

    def start(self,expected_id=None):
        config=read_config(self.root/'worker.json')
        if expected_id and config_worker_id(config)!=expected_id:
            raise ValueError('Perangkat pada tombol berbeda dari koneksi laptop. Impor file koneksi perangkat yang dipilih.')
        if self.running():
            return False
        executable=venv_python(self.root)
        if not executable.exists():
            raise ValueError('Klik Siapkan dependensi terlebih dahulu.')
        (self.root/'worker.stop').unlink(missing_ok=True)
        if self.log_handle: self.log_handle.close()
        self.log_handle=(self.root/'launcher-worker.log').open('ab')
        self.process=subprocess.Popen([str(executable),str(self.root/'worker.py'),'--managed'],cwd=self.root,
            stdout=self.log_handle,stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        return True

    def stop(self):
        (self.root/'worker.stop').touch()
