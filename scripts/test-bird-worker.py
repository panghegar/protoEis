from pathlib import Path
import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
import wave
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'worker'))
from bird_worker import inspect_wav,simulation_segment,safe_download_url,execute_bird
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
if __name__=='__main__':unittest.main()
