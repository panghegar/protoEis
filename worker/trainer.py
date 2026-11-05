"""Training sungguhan. Seluruh data, checkpoint dan hasil tetap di laptop."""
import argparse
import csv
import json
import os
from pathlib import Path
import time
import traceback
import threading
import uuid
import zipfile


def atomic_json(path, value):
    temp = path.with_name(f'{path.name}.{uuid.uuid4().hex}.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding='utf-8')
    try:
        # Windows may briefly hold the destination while an HTTP poll reads it.
        for attempt in range(40):
            try:
                os.replace(temp, path)
                break
            except PermissionError:
                if attempt == 39:
                    raise
                time.sleep(.025)
    finally:
        temp.unlink(missing_ok=True)


def train(folder):
    state = json.loads((folder / 'status.json').read_text(encoding='utf-8'))
    cfg = state['config']
    def watchdog():
        while True:
            time.sleep(10)
            try:
                if time.time() - (folder/'worker-alive').stat().st_mtime > 150:
                    (folder/'cancel').touch()
                    return
            except OSError:
                return
    threading.Thread(target=watchdog, daemon=True).start()
    started = time.monotonic()
    def update(**kwargs):
        state.update(kwargs, elapsed_seconds=round(time.monotonic() - started, 2))
        atomic_json(folder / 'status.json', state)
    try:
        update(status='starting', message='Memuat PyTorch dan dataset lokal…')
        import numpy as np
        import torch
        from sklearn.datasets import load_digits
        from sklearn.model_selection import train_test_split
        torch.set_num_threads(2)
        torch.manual_seed(cfg['seed'])
        np.random.seed(cfg['seed'])
        cuda = torch.cuda.is_available()
        if cfg['device'] == 'cuda' and not cuda:
            raise RuntimeError('GPU CUDA tidak tersedia. Periksa instalasi PyTorch atau pilih CPU.')
        device = 'cuda' if cuda and cfg['device'] != 'cpu' else 'cpu'
        data = load_digits()
        x = (data.data / 16.0).astype('float32')
        y = data.target.astype('int64')
        all_ids = np.arange(len(y))
        trainval, test = train_test_split(all_ids, test_size=.2, stratify=y, random_state=cfg['seed'])
        train_ids, val = train_test_split(trainval, test_size=.2, stratify=y[trainval], random_state=cfg['seed'])
        tx, ty = torch.tensor(x, device=device), torch.tensor(y, device=device)
        model = torch.nn.Sequential(torch.nn.Linear(64,128), torch.nn.ReLU(), torch.nn.Linear(128,64), torch.nn.ReLU(), torch.nn.Linear(64,10)).to(device)
        optimizer = torch.optim.Adam(model.parameters(), lr=cfg['learning_rate'])
        loss_fn = torch.nn.CrossEntropyLoss()
        split = {'train':len(train_ids),'validation':len(val),'test':len(test)}
        update(status='running', device=device, device_name=torch.cuda.get_device_name(0) if device=='cuda' else 'CPU', split=split, message='Training berlangsung. Tab boleh ditutup.')
        best = -1.0
        cancelled = False
        for epoch in range(1, cfg['epochs']+1):
            if (folder/'cancel').exists():
                cancelled = True
                break
            model.train()
            shuffled = np.random.permutation(train_ids)
            total_loss = 0
            for offset in range(0,len(shuffled),cfg['batch_size']):
                if (folder/'cancel').exists():
                    cancelled = True
                    break
                ids = shuffled[offset:offset+cfg['batch_size']]
                optimizer.zero_grad(set_to_none=True)
                loss = loss_fn(model(tx[ids]),ty[ids])
                if not torch.isfinite(loss):
                    raise RuntimeError('Loss tidak valid. Coba learning rate lebih kecil.')
                loss.backward()
                optimizer.step()
                total_loss += loss.item()*len(ids)
            if cancelled:
                break
            model.eval()
            with torch.no_grad():
                logits = model(tx[val])
                val_loss = loss_fn(logits,ty[val]).item()
                val_accuracy = (logits.argmax(1)==ty[val]).float().mean().item()
            row = {'epoch':epoch,'train_loss':round(total_loss/len(train_ids),6),'val_loss':round(val_loss,6),'val_accuracy':round(val_accuracy,6)}
            state['history'].append(row)
            weights = {k:v.detach().cpu() for k,v in model.state_dict().items()}
            if val_accuracy > best:
                best = val_accuracy
                torch.save({'weights':weights,'config':cfg,'architecture':'MLP 64-128-64-10','normalization':'pixel / 16.0','classes':list(range(10))}, folder/'model.pt')
            torch.save({'epoch':epoch,'weights':weights,'optimizer':optimizer.state_dict(),'config':cfg},folder/'checkpoint.pt')
            update(epoch=epoch, best_val_accuracy=best, message=f'Epoch {epoch}/{cfg["epochs"]} selesai', gpu_peak_mb=round(torch.cuda.max_memory_allocated()/1024**2,1) if device=='cuda' else None)
        if cancelled:
            update(status='cancelled', message='Training dihentikan. Hasil epoch lengkap tetap tersimpan.')
        else:
            saved = torch.load(folder/'model.pt',map_location=device,weights_only=True)
            model.load_state_dict(saved['weights'])
            model.eval()
            with torch.no_grad():
                predictions = model(tx[test]).argmax(1).cpu().numpy()
            accuracy = float((predictions == y[test]).mean())
            examples = [{'pixels':data.images[i].flatten().tolist(),'actual':int(y[i]),'predicted':int(p)} for i,p in zip(test[:12],predictions[:12])]
            update(status='finishing', test_accuracy=accuracy, examples=examples, message='Menyimpan hasil evaluasi dan paket model…')
        with (folder/'metrics.csv').open('w',newline='',encoding='utf-8') as f:
            writer=csv.DictWriter(f,fieldnames=['epoch','train_loss','val_loss','val_accuracy'])
            writer.writeheader(); writer.writerows(state['history'])
        report={**state,'status':'cancelled' if cancelled else 'completed','dataset':'sklearn digits (1797 gambar 8x8); data contoh, bukan data EIS','torch_version':torch.__version__,'note':'Test set terpisah; evaluasi akhir memakai model dengan akurasi validasi terbaik. Training baru dari awal; UI belum mendukung resume.'}
        atomic_json(folder/'report.json',report)
        with zipfile.ZipFile(folder/'hasil-training.zip','w',zipfile.ZIP_DEFLATED) as z:
            for name in ['model.pt','checkpoint.pt','metrics.csv','report.json']:
                if (folder/name).exists(): z.write(folder/name,name)
        update(status='cancelled' if cancelled else 'completed',download=True,message='Training dihentikan; hasil parsial tersedia.' if cancelled else 'Training selesai. Model terbaik dan evaluasi siap diunduh.')
    except Exception as exc:
        (folder/'error.log').write_text(traceback.format_exc(),encoding='utf-8')
        update(status='failed',message=str(exc))


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('folder',type=Path)
    train(parser.parse_args().folder)
