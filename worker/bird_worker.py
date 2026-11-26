"""WAV pipeline demo. Example labels are never scientific predictions."""
import hashlib
import json
import math
import os
import subprocess
from bird_model import installed_model,ready_model,bird_python
from pathlib import Path
import time
import urllib.request
from urllib.parse import urlsplit
import uuid
import wave
from trainer import atomic_json

VERSION=2
CHUNK_BYTES=20*1024*1024
MAX_BYTES=700*1024*1024

class Cancelled(Exception): pass

def inspect_wav(path):
    with wave.open(str(path),'rb') as audio:
        if audio.getcomptype()!='NONE' or audio.getnchannels() not in (1,2):
            raise ValueError('Demo mendukung WAV PCM mono/stereo tanpa kompresi.')
        if audio.getsampwidth() not in (1,2,3,4) or not 8000<=audio.getframerate()<=192000:
            raise ValueError('Bit depth atau sample rate WAV belum didukung.')
        frames=audio.getnframes()
        duration=frames/audio.getframerate()
        if not 0<duration<=7200: raise ValueError('Durasi WAV harus lebih dari 0 dan maksimal 2 jam untuk demo.')
        return dict(channels=audio.getnchannels(),sampleRate=audio.getframerate(),bits=audio.getsampwidth()*8,frames=frames,duration=duration)

def simulation_segment(ordinal,duration):
    labels=[('Contoh spesies A',.91),('unknown',.32),('Contoh spesies B',.84),('Contoh spesies A',.89),('unknown',.41)]
    species,confidence=labels[ordinal%len(labels)]
    return dict(ordinal=ordinal,startSeconds=ordinal*3,endSeconds=min(duration,(ordinal+1)*3),species=species,confidence=confidence)

def safe_download_url(url):
    parsed=urlsplit(url)
    # Local loopback is for integration fixtures. No worker bearer token goes to Storage.
    valid=(parsed.scheme=='https' and parsed.hostname and parsed.hostname.endswith('.supabase.co')) or (parsed.scheme=='http' and parsed.hostname in ('127.0.0.1','localhost'))
    if not valid or parsed.username or parsed.password or parsed.fragment:
        raise ValueError('Alamat unduh Storage tidak diizinkan.')
    return url

def execute_bird(client,job,capabilities,root,stop):
    ident=str(uuid.UUID(job['id']))
    runs=(root/'bird-runs');runs.mkdir(exist_ok=True)
    folder=runs/ident
    folder.mkdir(exist_ok=True)
    audio=job['audio'];simulation=job.get('config',{}).get('mode')!='inference'
    path=folder/('rekaman-sementara.mp3' if audio.get('mp3') else 'rekaman-sementara.wav')
    total=math.ceil((audio.get('wav') or audio['mp3'])['duration']/3)
    process=None;result_count=None
    state=dict(simulation=simulation,percent=0,phase='download',processedSegments=0,totalSegments=total,message='Menyiapkan rekaman.')
    sequence=0;last_ack=time.monotonic();last_progress=0;last_hardware=0
    terminal='failed';message='Proses identifikasi belum selesai.'
    active=root/'active-bird.json'
    atomic_json(active,{'id':ident,'lease':job['lease']})
    def check():
        if stop.exists():raise Cancelled('Worker dihentikan oleh pengguna.')
        if time.monotonic()-last_ack>140:raise RuntimeError('API tidak terjangkau; identifikasi dihentikan agar lease tidak tumpang tindih.')
    def post(suffix,body):
        nonlocal last_ack
        while True:
            check()
            try:
                reply=client.post('/worker/bird-jobs/'+ident+'/'+suffix,{'lease':job['lease'],**body})
                last_ack=time.monotonic()
                return reply
            except Exception as exc:
                if getattr(exc,'code',None) in (400,401,403,404,409,410):raise
                check();time.sleep(2)
    def pulse(percent=None,message=None,force=False):
        nonlocal sequence,last_progress,last_hardware
        check()
        if percent is not None:state['percent']=round(percent,2)
        if message:state['message']=message
        atomic_json(folder/'status.json',state)
        if not force and time.monotonic()-last_progress<2:return
        sequence+=1
        reply=post('progress',{'sequence':sequence,'progress':dict(state)})
        last_progress=time.monotonic()
        if reply['cancelRequested']:raise Cancelled('Identifikasi dibatalkan pengguna.')
        if time.monotonic()-last_hardware>=15:
            try:
                client.post('/worker/heartbeat',capabilities);last_hardware=time.monotonic()
            except Exception as exc:
                if getattr(exc,'code',None) in (400,401,403):raise
                # A temporary hardware-heartbeat failure need not discard acknowledged progress.

    try:
        if not 0<audio['size']<=MAX_BYTES or len(audio['hashes'])!=math.ceil(audio['size']/CHUNK_BYTES):
            raise ValueError('Manifest audio tidak valid.')
        pulse(force=True)
        downloaded=0
        with path.open('wb') as target:
            for index,expected in enumerate(audio['hashes']):
                check();pulse(force=True)
                ticket=post('download-ticket',{'index':index})
                start=target.tell();size=min(CHUNK_BYTES,audio['size']-index*CHUNK_BYTES)
                success=False
                for attempt in range(3):
                    target.seek(start);target.truncate();digest=hashlib.sha256();received=0
                    try:
                        request=urllib.request.Request(safe_download_url(ticket['url']))
                        with urllib.request.urlopen(request,timeout=20) as response:
                            while True:
                                check()
                                block=response.read(256*1024)
                                if not block:break
                                received+=len(block)
                                if received>size:raise ValueError('Ukuran bagian melebihi manifest.')
                                digest.update(block);target.write(block)
                                pulse(25*(downloaded+received)/audio['size'],'Mengunduh bagian '+str(index+1)+'/'+str(len(audio['hashes']))+'.')
                        if received!=size or digest.hexdigest()!=expected:raise ValueError('Checksum atau ukuran bagian audio tidak cocok.')
                        success=True;break
                    except (OSError,TimeoutError):
                        if attempt==2:raise
                        pulse(force=True);ticket=post('download-ticket',{'index':index});time.sleep(1)
                if not success:raise RuntimeError('Unduhan tidak selesai.')
                downloaded+=size
        if simulation:
            actual=inspect_wav(path)
            for key in ('channels','sampleRate','bits','frames'):
                if actual[key]!=audio['wav'][key]:raise ValueError('Isi WAV berbeda dari metadata unggahan.')
            if abs(actual['duration']-audio['wav']['duration'])>.001:raise ValueError('Durasi WAV berbeda dari manifest.')
            state['phase']='process';pulse(25,'SIMULASI: membaca WAV; label dan keyakinan adalah contoh.',True)
            batch=[];local_results=[]
            with wave.open(str(path),'rb') as source:
                for ordinal in range(total):
                    check()
                    frame_count=min(3*actual['sampleRate'],actual['frames']-ordinal*3*actual['sampleRate'])
                    block=source.readframes(frame_count)
                    if len(block)!=frame_count*actual['channels']*(actual['bits']//8):raise ValueError('Data WAV terpotong atau rusak.')
                    row=simulation_segment(ordinal,actual['duration']);batch.append(row);local_results.append(row)
                    if len(batch)==50 or ordinal==total-1:
                        post('segments',{'segments':batch});batch=[]
                    state['processedSegments']=ordinal+1
                    pulse(25+70*(ordinal+1)/total,'SIMULASI: segmen '+str(ordinal+1)+'/'+str(total)+'.')
                    time.sleep(.02)
            state['phase']='finish';pulse(99,'Menyimpan hasil simulasi dan menyiapkan unduhan XLSX.',True)
            atomic_json(folder/'hasil-simulasi.json',{'simulation':True,'note':'BUKAN hasil identifikasi burung. Model belum tersedia.','audio':{k:v for k,v in audio.items() if k!='hashes'},'segments':local_results})
            terminal='completed';message='Simulasi selesai. Label dan keyakinan adalah data contoh, bukan prediksi model.'
        else:
            if audio.get('wav'):
                actual=inspect_wav(path)
                if any(actual[key]!=audio['wav'][key] for key in ('channels','sampleRate','bits','frames')):
                    raise ValueError('Isi WAV berbeda dari metadata unggahan.')
            model,_=installed_model(root,verify=True)
            if not ready_model(root) or model['id']!=job['config']['model']['id']:
                raise ValueError('Model lokal berbeda dari model yang dipilih saat tugas dibuat. Impor dan siapkan model yang sesuai.')
            state['phase']='process';pulse(27,'Memuat model Sumatra sementara pada CPU.',True)
            with (folder/'inference.log').open('wb') as log:
                process=subprocess.Popen([str(bird_python(root)),str(root/'bird_inference.py'),'infer',str(root),str(path),str(folder),str(os.getpid())],
                    cwd=root,stdout=log,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
            duration_sent=False
            while process.poll() is None:
                check()
                try:
                    info=json.loads((folder/'inference-state.json').read_text(encoding='utf-8'))
                    if not duration_sent:
                        post('metadata',{'duration':info['duration']});duration_sent=True
                        state['totalSegments']=math.ceil(info['duration']/3)
                    pulse(info['percent'],info['message'])
                except (FileNotFoundError,json.JSONDecodeError):pulse()
                time.sleep(.5)
            if process.returncode!=0:
                raise RuntimeError('Inference berhenti. Periksa inference.log pada folder hasil lokal.')
            result=json.loads((folder/'inference-result.json').read_text(encoding='utf-8'))
            if result['model']['id']!=model['id']:raise ValueError('ID model hasil tidak sesuai.')
            if not duration_sent:post('metadata',{'duration':result['duration']})
            state['totalSegments']=math.ceil(result['duration']/3)
            rows=result['segments'];result_count=len(rows)
            for offset in range(0,len(rows),50):
                batch=rows[offset:offset+50];post('segments',{'segments':batch})
                state['processedSegments']=batch[-1]['windowIndex']+1
                pulse(82+16*(offset+len(batch))/len(rows),'Menyimpan hasil identifikasi ke website.')
            state['phase']='finish';pulse(99,'Menyiapkan hasil identifikasi dan XLSX.',True)
            terminal='completed';message='Identifikasi selesai menggunakan model Sumatra sementara. Confidence adalah skor model, bukan ukuran akurasi.'
    except Cancelled as exc:
        terminal='cancelled';message=str(exc)
    except Exception as exc:
        terminal='failed'
        # Never include signed URLs or credentials in the API report.
        message=('Simulasi' if simulation else 'Identifikasi')+' gagal ('+type(exc).__name__+'). '+(str(exc) if isinstance(exc,ValueError) else 'Periksa inference.log di laptop, koneksi, dan kelengkapan WAV/MP3.')
    finally:
        if process and process.poll() is None:
            process.terminate()
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=10)
        path.unlink(missing_ok=True)
        # Completion must still be sent after a local stop request.
        deadline=time.monotonic()+35
        reported=False
        while time.monotonic()<deadline:
            try:
                reply=client.post('/worker/bird-jobs/'+ident+'/complete',{'lease':job['lease'],'status':terminal,'message':message,**({'resultCount':result_count} if result_count else {})})
                terminal=reply['status'];reported=True;break
            except Exception as exc:
                if getattr(exc,'code',None) in (400,401,403,404,409,410):break
                time.sleep(2)
        if not reported:message+=' Status akhir belum dikonfirmasi API; periksa website. Hasil komputasi tetap lokal.'
        atomic_json(folder/'status.json',{**state,'status':terminal,'reported':reported,'message':message,**({'resultCount':result_count} if result_count else {})})
        active.unlink(missing_ok=True)
        print(('Identifikasi SIMULASI ' if simulation else 'Identifikasi model sementara ')+ident[:8]+': '+terminal+'. '+message,flush=True)

def recover_bird(client,root):
    path=root/'active-bird.json'
    if not path.exists():return
    record=json.loads(path.read_text(encoding='utf-8'))
    ident=str(uuid.UUID(record['id']))
    for suffix in ('wav','mp3'):(root/'bird-runs'/ident/('rekaman-sementara.'+suffix)).unlink(missing_ok=True)
    try:client.post('/worker/bird-jobs/'+ident+'/complete',{'lease':record['lease'],'status':'failed','message':'Worker dimulai ulang setelah identifikasi terputus. Buat proses baru; hasil lama tetap tersimpan.'})
    except Exception as exc:
        if getattr(exc,'code',None) not in (401,403,404,409,410):raise
    path.unlink(missing_ok=True)
