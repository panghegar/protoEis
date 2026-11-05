"""End-to-end localhost smoke test; API + worker must already be running."""
import json,time,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
cfg=json.loads((ROOT/'.local/local-config.json').read_text(encoding='utf-8-sig'))
worker=json.loads((ROOT/'worker/worker.json').read_text(encoding='utf-8-sig'))
base=worker['apiUrl'].rstrip('/')
if base!='http://127.0.0.1:3001/api': raise RuntimeError('Smoke test hanya untuk API prototipe lokal.')
token=None
def api(path,body=None):
    req=urllib.request.Request(base+path,data=None if body is None else json.dumps(body).encode(),headers={
        **({'Authorization':'Bearer '+token} if token else {}),
        **({'Content-Type':'application/json'} if body is not None else {})})
    with urllib.request.urlopen(req,timeout=20) as r:return json.load(r)
token=api('/auth/login',{'email':cfg['adminEmail'],'password':cfg['adminPassword']})['token']
worker_id=worker['token'].split('.')[0]
def submit(epochs):
    return api('/jobs',{'workerId':worker_id,'config':{'epochs':epochs,'batch_size':64,'learning_rate':.001,'seed':789,'device':'cpu'}})
def wait(ident,terminal=True):
    end=time.monotonic()+180
    while time.monotonic()<end:
        job=next(j for j in api('/jobs') if j['id']==ident)
        if (terminal and job['status'] in ['completed','failed','cancelled','interrupted']) or (not terminal and job['status']=='running'):return job
        time.sleep(.5)
    raise RuntimeError('Training timeout.')
job=submit(10)
result=wait(job['id'])
assert result['status']=='completed',result['status']
assert result['progress']['device']=='cpu'
assert result['progress']['test_accuracy']>.8
assert (ROOT/'worker/runs'/job['id']/'hasil-training.zip').exists()
print('PASS CPU via API/worker: accuracy='+str(round(result['progress']['test_accuracy'],3)),flush=True)
cancel=submit(200)
wait(cancel['id'],False)
api('/jobs/'+cancel['id']+'/cancel',{})
result=wait(cancel['id'])
assert result['status']=='cancelled',result['status']
assert 'test_accuracy' not in result['progress']
assert (ROOT/'worker/runs'/cancel['id']/'hasil-training.zip').exists()
print('PASS running cancellation and local partial ZIP',flush=True)
