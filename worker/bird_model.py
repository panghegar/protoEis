"""Import data-only model ZIPs. No code from an imported archive is executed."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import tempfile
import zipfile
from trainer import atomic_json

MODEL_NAME = 'Sumatra BirdNET 2.4 — sementara'
MODEL_FILE = 'Sumatra_BirdNET_2.4_Custom.tflite'
LABEL_FILE = 'Sumatra_BirdNET_2.4_Custom_Labels.txt'
PIPELINE = 'sumatra-enhanced-v1'
MAX_PACKAGE_BYTES = 100 * 1024 * 1024


def model_id(model, labels):
    return hashlib.sha256(model + b'\0' + labels).hexdigest()


def validate_payload(model, labels):
    if len(model) < 100 or model[4:8] != b'TFL3':
        raise ValueError('Berkas model bukan TensorFlow Lite yang didukung.')
    names = labels.decode('utf-8-sig').splitlines()
    if not names or len(names) > 10000 or any(not n.strip() or len(n) > 300 for n in names) or len(set(names)) != len(names):
        raise ValueError('Daftar label model kosong, berulang, atau tidak valid.')
    return len(names)


def read_package(source):
    if source.stat().st_size > MAX_PACKAGE_BYTES:
        raise ValueError('Batas paket model tahap ini adalah 100 MiB.')
    with zipfile.ZipFile(source) as archive:
        files = archive.infolist()
        if len(files) > 100 or sum(f.file_size for f in files) > MAX_PACKAGE_BYTES:
            raise ValueError('Isi paket model terlalu besar.')
        selected = {}
        for entry in files:
            path = PurePosixPath(entry.filename.replace('\\', '/'))
            if path.is_absolute() or '..' in path.parts or ':' in entry.filename or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('Paket model mengandung lokasi berkas yang tidak aman.')
            if path.name in (MODEL_FILE, LABEL_FILE):
                if path.name in selected or entry.flag_bits & 1:
                    raise ValueError('Berkas model/label berulang atau terenkripsi.')
                selected[path.name] = archive.read(entry)
        if set(selected) != {MODEL_FILE, LABEL_FILE}:
            raise ValueError('Paket harus memuat model Sumatra .tflite dan berkas label pasangannya.')
    model, labels = selected[MODEL_FILE], selected[LABEL_FILE]
    return model, labels, validate_payload(model, labels)


def import_model(source, root):
    model, labels, count = read_package(source)
    ident = model_id(model, labels)
    models = root / 'bird-models'
    models.mkdir(exist_ok=True)
    target = models / ident
    if not target.exists():
        staging = Path(tempfile.mkdtemp(prefix='import-', dir=models))
        try:
            (staging / MODEL_FILE).write_bytes(model)
            (staging / LABEL_FILE).write_bytes(labels)
            os.replace(staging, target)
        finally:
            if staging.exists(): shutil.rmtree(staging)
    manifest = dict(id=ident, name=MODEL_NAME, temporary=True, pipeline=PIPELINE, labelCount=count)
    atomic_json(root / 'bird-model.json', manifest)
    # A different import must pass runtime verification before it can claim jobs.
    (root / 'bird-ready.json').unlink(missing_ok=True)
    return manifest


def installed_model(root, verify=False):
    manifest = json.loads((root / 'bird-model.json').read_text(encoding='utf-8'))
    ident = manifest['id']
    if not isinstance(ident, str) or len(ident) != 64 or any(c not in '0123456789abcdef' for c in ident):
        raise ValueError('ID model lokal tidak valid.')
    folder = root / 'bird-models' / ident
    if verify:
        model, labels = (folder / MODEL_FILE).read_bytes(), (folder / LABEL_FILE).read_bytes()
        if model_id(model, labels) != ident or validate_payload(model, labels) != manifest['labelCount']:
            raise ValueError('Model/label lokal berubah. Impor ulang paket model.')
    if manifest.get('pipeline') != PIPELINE or manifest.get('temporary') is not True:
        raise ValueError('Versi pipeline model belum didukung.')
    return manifest, folder


def bird_python(root):
    return root / '.bird-venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')


def setup_bird_commands(root):
    from launcher_core import python_console
    py, runtime = python_console(), str(bird_python(root))
    if os.name == 'nt' and len(str(bird_python(root).resolve().parent.parent)) > 70:
        raise ValueError('Folder worker terlalu panjang untuk TensorFlow pada Windows ini. Ekstrak paket worker ke folder pendek, misalnya C:\\EIS\\worker, lalu ulangi persiapan.')
    commands = []
    if not Path(runtime).exists(): commands.append([py, '-m', 'venv', '--without-pip', str(root / '.bird-venv')])
    commands.extend([
        [py, '-m', 'pip', '--python', runtime, 'install', '-r', str(root / 'requirements-bird.txt')],
        [runtime, str(root / 'bird_inference.py'), 'probe', str(root)],
    ])
    return commands


def ready_model(root):
    try:
        manifest, _ = installed_model(root)
        ready = json.loads((root / 'bird-ready.json').read_text(encoding='utf-8'))
        if ready['id'] == manifest['id'] and ready.get('pipeline') == PIPELINE and bird_python(root).exists():
            return manifest
    except (OSError, ValueError, KeyError):
        pass
    return None
