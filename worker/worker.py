"""Worker keluar saja: tidak membuka HTTP port pada laptop."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import urllib.request
import urllib.error
from urllib.parse import urlparse
import uuid
from trainer import atomic_json

ROOT = Path(__file__).resolve().parent
STOP = ROOT / 'worker.stop'
RUNS = ROOT / 'runs'
RUNS.mkdir(exist_ok=True)
KEYS = {'epoch','history','message','elapsed_seconds','best_val_accuracy','test_accuracy','device','device_name','gpu_peak_mb','split','examples'}

class ApiFailure(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(f'API menolak permintaan (HTTP {code}).')

class Client:
    def __init__(self, config):
        self.base = config['apiUrl'].rstrip('/')
        parsed = urlparse(self.base)
        if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1','localhost')):
            raise ValueError('API harus HTTPS, kecuali localhost.')
        if not self.base.endswith('/api'):
            raise ValueError('apiUrl harus diakhiri /api.')
        self.token = config['token']
    def post(self, path, body):
        req = urllib.request.Request(self.base+path, data=json.dumps(body,allow_nan=False).encode(),
            headers={'Content-Type':'application/json','Authorization':'Bearer '+self.token}, method='POST')
        try:
            with urllib.request.urlopen(req,timeout=20) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            raise ApiFailure(exc.code) from None

def hardware():
    import torch
    available=torch.cuda.is_available()
    return {'cuda':available,'gpu':torch.cuda.get_device_name(0) if available else None,
        'vram_gb':round(torch.cuda.get_device_properties(0).total_memory/1024**3,1) if available else None,
        'torch':str(torch.__version__),'python':sys.version.split()[0]}

def read_status(folder):
    try: return json.loads((folder/'status.json').read_text(encoding='utf-8'))
    except (OSError,ValueError): return {'epoch':0,'history':[],'message':'Menyiapkan training lokal…'}

def progress_only(state):
    return {key:value for key,value in state.items() if key in KEYS}

def stop_process(proc,folder):
    (folder/'cancel').touch()
    try: proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.terminate()
        proc.wait(timeout=15)

def execute(client,job,capabilities):
    ident=str(uuid.UUID(job['id']))
    folder=RUNS/ident
    if folder.exists():
        raise RuntimeError('ID tugas sudah memiliki hasil lokal; training tidak dijalankan ulang otomatis.')
    folder.mkdir()
    state={'id':ident,'config':job['config'],'status':'starting','epoch':0,'history':[],'message':'Memuat model lokal…'}
    atomic_json(folder/'status.json',state)
    atomic_json(ROOT/'active.json',{'id':ident,'lease':job['lease']})
    (folder/'worker-alive').touch()
    proc=None
    last_ack=time.monotonic()
    sequence=0
    last_hardware=0.0
    acknowledged=False
    print(f"Training {ident[:8]} dimulai ({job['config']['device']}, {job['config']['epochs']} epoch).",flush=True)
    try:
        with (folder/'worker.log').open('wb') as log:
            proc=subprocess.Popen([sys.executable,str(ROOT/'trainer.py'),str(folder)],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        while True:
            if STOP.exists(): (folder/'cancel').touch()
            (folder/'worker-alive').touch()
            state=read_status(folder)
            sequence+=1
            try:
                reply=client.post('/worker/jobs/'+ident+'/progress',{'lease':job['lease'],'sequence':sequence,'progress':progress_only(state)})
                last_ack=time.monotonic()
                if reply['cancelRequested']: (folder/'cancel').touch()
                if time.monotonic()-last_hardware>15:
                    client.post('/worker/heartbeat',capabilities)
                    last_hardware=time.monotonic()
                acknowledged=True
            except ApiFailure as exc:
                if exc.code in (401,403,409):
                    stop_process(proc,folder)
                    print(str(exc)+' Worker menghentikan tugas; hasil tetap lokal.',flush=True)
                    return
                acknowledged=False
            except (OSError,TimeoutError):
                acknowledged=False
            if time.monotonic()-last_ack>140:
                stop_process(proc,folder)
                print('API tidak terjangkau. Training dihentikan agar lease tidak tumpang tindih. Hasil tetap lokal.',flush=True)
                return
            if proc.poll() is not None and acknowledged:
                break
            time.sleep(2)
        state=read_status(folder)
        terminal=state.get('status')
        if terminal not in ('completed','cancelled','failed'):
            terminal='failed'
            state['message']='Proses training berhenti sebelum menyimpan status akhir. Periksa worker.log.'
        uploaded=False
        # The model travels directly to private Storage, never through a Vercel request body.
        if (folder/'hasil-training.zip').exists():
            try:
                ticket=client.post('/worker/jobs/'+ident+'/upload-ticket',{'lease':job['lease']})
                if ticket['enabled']:
                    if urlparse(ticket['url']).scheme!='https': raise ValueError('Upload URL harus HTTPS.')
                    request=urllib.request.Request(ticket['url'],data=(folder/'hasil-training.zip').read_bytes(),
                        headers={'Content-Type':'application/zip'},method='PUT')
                    with urllib.request.urlopen(request,timeout=60) as response:
                        uploaded=200<=response.status<300
            except (ApiFailure,OSError,ValueError,TimeoutError):
                state['message']=state.get('message','')+' Model disimpan lokal; unggahan cloud gagal.'
        if terminal=='completed' and not uploaded:
            state['message']='Training selesai. Model tersimpan di laptop; laporan tersedia di website.'
        while time.monotonic()-last_ack<140:
            try:
                result=client.post('/worker/jobs/'+ident+'/complete',{'lease':job['lease'],'status':terminal,
                    'progress':progress_only(state),'artifactUploaded':uploaded})
                print(f"Tugas {ident[:8]}: {result['status']}. Hasil: {folder}",flush=True)
                return
            except ApiFailure as exc:
                if exc.code in (401,403,409): print(str(exc)+' Hasil tetap lokal.',flush=True);return
            except (OSError,TimeoutError): pass
            time.sleep(5)
        print('Pengiriman status akhir belum berhasil. Hasil lengkap tetap tersedia lokal.',flush=True)
    except KeyboardInterrupt:
        if proc: stop_process(proc,folder)
        state=read_status(folder)
        state['message']='Worker dihentikan oleh pengguna.'
        try: client.post('/worker/jobs/'+ident+'/complete',{'lease':job['lease'],'status':'cancelled','progress':progress_only(state)})
        except Exception: pass
        raise
    finally:
        if proc and proc.poll() is None: stop_process(proc,folder)
        (ROOT/'active.json').unlink(missing_ok=True)

def acquire_lock():
    handle=(ROOT/'worker.lock').open('a+b')
    handle.seek(0);handle.write(b'1');handle.flush();handle.seek(0)
    try:
        if os.name=='nt':
            import msvcrt
            msvcrt.locking(handle.fileno(),msvcrt.LK_NBLCK,1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
    except OSError:
        handle.close()
        raise RuntimeError('Worker lain masih berjalan dari folder ini.')
    return handle

def recover(client):
    active=ROOT/'active.json'
    if not active.exists(): return
    record=json.loads(active.read_text(encoding='utf-8'))
    folder=RUNS/str(uuid.UUID(record['id']))
    (folder/'cancel').touch()
    # A child surviving a hard-killed parent stops at batch boundaries or by watchdog.
    deadline=time.monotonic()+180
    while time.monotonic()<deadline and read_status(folder).get('status') not in ('completed','cancelled','failed'):
        time.sleep(2)
    state=read_status(folder)
    state['message']='Worker dimulai ulang setelah sesi sebelumnya terputus; hasil lama tetap lokal.'
    try:
        client.post('/worker/jobs/'+record['id']+'/complete',{'lease':record['lease'],'status':'failed','progress':progress_only(state)})
    except ApiFailure as exc:
        if exc.code not in (401,403,409): raise
    active.unlink(missing_ok=True)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--config',type=Path,default=ROOT/'worker.json')
    parser.add_argument('--managed',action='store_true',help='Dijalankan launcher; gunakan permintaan stop lokal.')
    parser.add_argument('--once',action='store_true',help='Proses satu tugas yang sudah mengantre lalu keluar.')
    args=parser.parse_args()
    lock=acquire_lock()
    if not args.managed: STOP.unlink(missing_ok=True)
    try:
        client=Client(json.loads(args.config.read_text(encoding='utf-8-sig')))
        caps=hardware()
        print('Worker EIS | '+(caps['gpu'] or 'CPU')+' | '+client.base,flush=True)
        recover(client)
        while not STOP.exists():
            try:
                client.post('/worker/heartbeat',caps)
                if STOP.exists(): break
                job=client.post('/worker/claim',{})['job']
                if job: execute(client,job,caps)
                if args.once: return
                time.sleep(5)
            except ApiFailure as exc:
                print(str(exc),flush=True)
                if exc.code in (401,403): raise RuntimeError('Konfigurasi worker dicabut/tidak valid. Daftarkan ulang perangkat.') from None
                time.sleep(10)
            except (OSError,TimeoutError):
                print('API belum terhubung. Mencoba kembali dalam 10 detik.',flush=True)
                time.sleep(10)
    finally: lock.close()

if __name__=='__main__':
    try: main()
    except KeyboardInterrupt: print('Worker dihentikan.',flush=True)
