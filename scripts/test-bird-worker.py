from pathlib import Path
import hashlib
import importlib.util
import json
import io
import sys
import tempfile
import unittest
import wave
import zipfile
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'worker'))
from bird_worker import inspect_wav,simulation_segment,safe_download_url,execute_bird
from bird_model import import_model,installed_model,MODEL_FILE,LABEL_FILE
from bird_inference import fuse,read_predictions
class BirdTests(unittest.TestCase):
    def test_short_last_segment_and_example_labels(self):
        self.assertEqual(simulation_segment(2,7.5)['endSeconds'],7.5)
        self.assertEqual(simulation_segment(1,7.5)['species'],'unknown')
        self.assertEqual(simulation_segment(0,7.5)['species'],'Contoh spesies A')
    def test_valid_pcm_and_broken_wav(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'valid.wav'
            with wave.open(str(path),'wb') as f:f.setparams((1,2,16000,0,'NONE','not compressed'));f.writeframes(b'\0\0'*16000)
            self.assertEqual(inspect_wav(path)['duration'],1)
            path.write_bytes(b'not a wave')
            with self.assertRaises((wave.Error,EOFError)):inspect_wav(path)
    def test_storage_url_never_accepts_arbitrary_host(self):
        self.assertTrue(safe_download_url('https://project.supabase.co/storage/v1/object/sign/a?token=x'))
        for url in ['http://example.com/file','file:///C:/secret','https://project.supabase.co.evil.example/file','https://user:pw@project.supabase.co/file']:
            with self.subTest(url=url),self.assertRaises(ValueError):safe_download_url(url)
    def test_local_stop_reports_cancellation_without_downloading(self):
        class Client:
            def __init__(self):self.calls=[]
            def post(self,path,body):self.calls.append((path,body));return {'status':body.get('status','cancelled')}
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);stop=root/'worker.stop';stop.touch();c=Client()
            job={'id':'9b001d19-21af-4d3c-a0a8-2ebf18ac566b','lease':'a'*64,'audio':{'size':100,'hashes':['a'*64],'wav':{'duration':1}}}
            execute_bird(c,job,{},root,stop)
            self.assertEqual(c.calls[0][1]['status'],'cancelled')
            self.assertFalse((root/'active-bird.json').exists())
            self.assertFalse((root/'bird-runs'/job['id']/'rekaman-sementara.wav').exists())
class ModelTests(unittest.TestCase):
    def test_import_is_data_only_versioned_and_checks_integrity(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);archive=root/'model.zip'
            with zipfile.ZipFile(archive,'w') as z:
                z.writestr('custom/'+MODEL_FILE,b'\0\0\0\0TFL3'+b'\0'*200)
                z.writestr('custom/'+LABEL_FILE,'Species A_Common A\nSpecies B_Common B\n')
                z.writestr('inference.py','raise RuntimeError("must never execute")')
            model=import_model(archive,root)
            self.assertEqual(model['labelCount'],2)
            self.assertEqual(installed_model(root,True)[0]['id'],model['id'])
            self.assertFalse((root/'inference.py').exists())
            (root/'bird-models'/model['id']/LABEL_FILE).write_text('changed',encoding='utf-8')
            with self.assertRaises(ValueError):installed_model(root,True)
    def test_zip_traversal_and_duplicate_models_are_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);archive=root/'bad.zip'
            with zipfile.ZipFile(archive,'w') as z:z.writestr('../outside.txt','bad')
            with self.assertRaises(ValueError):import_model(archive,root)
            self.assertFalse((root.parent/'outside.txt').exists())
            with zipfile.ZipFile(archive,'w') as z:
                z.writestr('a/'+MODEL_FILE,b'data');z.writestr('b/'+MODEL_FILE,b'data')
            with self.assertRaises(ValueError):import_model(archive,root)
    def test_fusion_keeps_overlapping_species_and_distinguishes_no_detection(self):
        row=lambda score,name:dict(Confidence=str(score),**{'Common name':name})
        g={(0.,3.,'Species A'):row(.2,'A'),(0.,3.,'Species B'):row(.8,'B'),(6.,9.,'unknown'):row(.7,'Unknown')}
        c={(0.,3.,'Species A'):row(.8,'A')}
        rows=fuse(g,c,{'Species A','Species B','unknown'},{'Species A'},7.5)
        self.assertEqual(len(rows),4)
        self.assertAlmostEqual(rows[0]['confidence'],.424)
        self.assertEqual(rows[0]['evidence'],'BirdNET + Sumatra')
        self.assertEqual(rows[1]['species'],'Species B')
        self.assertEqual(rows[2]['status'],'no_detection')
        self.assertEqual(rows[2]['species'],'Tidak ada deteksi')
        self.assertEqual(rows[3]['status'],'unknown')
        self.assertEqual(rows[3]['endSeconds'],7.5)
        clamped=fuse({(6.,6.5,'Species A'):row(.8,'A')},{},{'Species A'},set(),6.5)
        self.assertEqual(clamped[-1]['endSeconds'],6.5)
        self.assertEqual(clamped[-1]['status'],'detected')
    def test_missing_output_is_failure_not_silently_no_detection(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaises(RuntimeError):read_predictions(Path(temp)/'missing.csv')
    def test_real_subprocess_cancellation_terminates_and_removes_audio(self):
        model={'id':'b'*64};started=[]
        class Process:
            returncode=None
            def poll(self):return self.returncode
            def terminate(self):self.returncode=-1
            def wait(self,timeout=None):return self.returncode
        process=Process()
        def spawn(*args,**kwargs):started.append(True);return process
        class Client:
            def __init__(self):self.calls=[]
            def post(self,path,body):
                self.calls.append((path,body))
                if path.endswith('/download-ticket'):return {'url':'https://fixture.supabase.co/audio'}
                if path.endswith('/progress'):return {'cancelRequested':bool(started)}
                return {'status':body.get('status','running')}
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);client=Client();content=b'audio fixture'
            job={'id':'9b001d19-21af-4d3c-a0a8-2ebf18ac566b','lease':'a'*64,'config':{'mode':'inference','model':model},
                'audio':{'size':len(content),'hashes':[hashlib.sha256(content).hexdigest()],'mp3':{'duration':1}}}
            ticks=iter(range(0,10000,3))
            with patch('bird_worker.installed_model',return_value=(model,root)),patch('bird_worker.ready_model',return_value=model),\
                 patch('bird_worker.urllib.request.urlopen',side_effect=lambda *a,**kw:io.BytesIO(content)),\
                 patch('bird_worker.subprocess.Popen',side_effect=spawn),patch('bird_worker.time.monotonic',side_effect=lambda:next(ticks)),patch('bird_worker.time.sleep'):
                execute_bird(client,job,{},root,root/'stop')
            self.assertEqual(process.returncode,-1)
            completion=[body for path,body in client.calls if path.endswith('/complete')][0]
            self.assertEqual(completion['status'],'cancelled')
            self.assertFalse((root/'bird-runs'/job['id']/'rekaman-sementara.mp3').exists())

if __name__=='__main__':unittest.main()
