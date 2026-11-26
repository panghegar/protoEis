"""Isolated BirdNET subprocess; implements Syafiq's two-pass score fusion.

Only model weights and labels are imported from the ZIP. Confidence is a model
score, not measured accuracy. No location filter is applied in this iteration.
"""
import csv
import json
import math
import os
from pathlib import Path
import sys
import threading
import time
from bird_model import installed_model, MODEL_FILE, LABEL_FILE, PIPELINE
from trainer import atomic_json

os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '2')
os.environ['CUDA_VISIBLE_DEVICES'] = '-1'  # This inference integration uses CPU.


def audio_info(path):
    import soundfile as sf
    info = sf.info(str(path))
    if info.format not in ('WAV', 'WAVEX', 'MP3') or info.channels not in (1, 2) or not 8000 <= info.samplerate <= 192000:
        raise ValueError('Audio harus WAV/MP3 mono/stereo, 8–192 kHz.')
    if (path.suffix.lower() == '.mp3') != (info.format == 'MP3'):
        raise ValueError('Isi audio berbeda dari ekstensi WAV/MP3 yang diunggah.')
    if info.format in ('WAV','WAVEX') and info.subtype not in ('PCM_U8','PCM_16','PCM_24','PCM_32'):
        raise ValueError('WAV harus memakai PCM 8/16/24/32-bit.')
    duration = info.frames / info.samplerate
    if not 0 < duration <= 7200:
        raise ValueError('Durasi audio harus lebih dari 0 dan maksimal 2 jam.')
    return dict(duration=duration, channels=info.channels, sampleRate=info.samplerate, format=info.format)


def read_predictions(path):
    if not path.is_file():
        raise RuntimeError('BirdNET tidak menyimpan CSV hasil; proses tidak dianggap tanpa deteksi.')
    result = {}
    with path.open(encoding='utf-8-sig', newline='') as stream:
        reader = csv.DictReader(stream)
        required = {'Start (s)', 'End (s)', 'Scientific name', 'Common name', 'Confidence'}
        if not required.issubset(reader.fieldnames or []): raise ValueError('Format hasil BirdNET tidak sesuai.')
        for row in reader:
            start, end, confidence = float(row['Start (s)']), float(row['End (s)']), float(row['Confidence'])
            if not all(math.isfinite(v) for v in (start, end, confidence)) or not 0 <= confidence <= 1:
                raise ValueError('Hasil model mengandung angka tidak valid.')
            result[(start, end, row['Scientific name'])] = row
    return result


def fuse(global_rows, custom_rows, global_species, custom_species, duration, threshold=.25, boost=.35):
    """Keep all species above threshold, including simultaneous detections."""
    windows = [[] for _ in range(math.ceil(duration / 3))]
    for key in sorted(set(global_rows) | set(custom_rows)):
        start, end, species = key
        index = round(start / 3)
        expected_end = min(duration, start + 3)
        # Analyzer rounds CSV timestamps to 2 decimals and clamps its final window.
        if index < 0 or index >= len(windows) or abs(start - index * 3) > .01 or end <= start or min(abs(end - (start + 3)),abs(end - expected_end)) > .011:
            raise ValueError('Rentang waktu hasil BirdNET tidak sesuai kontrak segmen 3 detik.')
        g, c = global_rows.get(key), custom_rows.get(key)
        gs, cs = float(g['Confidence']) if g else 0., float(c['Confidence']) if c else 0.
        score = gs + boost * cs * (1 - gs) if species in custom_species and species in global_species else cs if species in custom_species else gs
        if score < threshold: continue
        row = c if cs > gs and c else g or c
        windows[index].append(dict(windowIndex=index, startSeconds=index*3, endSeconds=min(duration, (index+1)*3),
            species=species, commonName=row.get('Common name', ''), confidence=round(score, 4),
            status='unknown' if species.casefold() == 'unknown' else 'detected',
            globalConfidence=round(gs, 4), customConfidence=round(cs, 4),
            evidence='BirdNET + Sumatra' if gs and cs else 'Sumatra' if cs else 'BirdNET'))
    result = []
    for index, rows in enumerate(windows):
        if not rows: rows = [dict(windowIndex=index, startSeconds=index*3, endSeconds=min(duration,(index+1)*3),
            species='Tidak ada deteksi', commonName='', confidence=0., status='no_detection',
            globalConfidence=None, customConfidence=None, evidence='Tidak ada skor yang melewati ambang')]
        for row in rows:
            row['ordinal'] = len(result)
            result.append(row)
    if len(result) > 1000000: raise ValueError('Hasil melebihi batas satu juta baris per pekerjaan prototipe.')
    return result


def validate_runtime(root):
    import birdnet_analyzer.config as config
    from birdnet_analyzer.analyze.core import analyze
    import tensorflow as tf
    manifest, folder = installed_model(root, verify=True)
    # Force real model loading, not just import success. Analyzer handles backbone download.
    interpreter = tf.lite.Interpreter(model_path=str(folder / MODEL_FILE), num_threads=1)
    interpreter.allocate_tensors()
    if interpreter.get_input_details()[0]['shape'].tolist() != [1,144000] or interpreter.get_output_details()[0]['shape'].tolist() != [1,manifest['labelCount']]:
        raise ValueError('Bentuk input/output model tidak cocok dengan paket Sumatra ini.')
    return manifest, folder, config, analyze


def infer(root, audio, output):
    manifest, folder, config, analyze = validate_runtime(root)
    info = audio_info(audio)
    output.mkdir(parents=True, exist_ok=True)
    def stage(percent, message):
        atomic_json(output/'inference-state.json', dict(percent=percent, message=message, duration=info['duration']))
    labels = (folder/LABEL_FILE).read_text(encoding='utf-8-sig').splitlines()
    global_labels_path = Path(config.BIRDNET_LABELS_FILE)
    if not global_labels_path.is_file(): raise RuntimeError('Label BirdNET global belum tersedia. Jalankan persiapan model pada launcher.')
    global_labels = global_labels_path.read_text(encoding='utf-8-sig').splitlines()
    candidate = .05
    # Analyze every nonempty tail rather than silently skipping tails <1 second.
    # BirdNET pads the final chunk with zeros; displayed timestamps remain bounded.
    config.SIG_MINLEN = 1 / 48000
    stage(30, 'Menjalankan BirdNET global pada CPU; tahap ini dapat memerlukan waktu.')
    config.LABELS_FILE = config.BIRDNET_LABELS_FILE
    analyze(audio_input=str(audio), output=str(output/'global'), min_conf=candidate, classifier=None, rtype='csv', threads=1)
    stage(55, 'Menjalankan classifier Sumatra sementara pada CPU.')
    analyze(audio_input=str(audio), output=str(output/'sumatra'), min_conf=candidate, classifier=str(folder/MODEL_FILE), rtype='csv', threads=1)
    stage(80, 'Menggabungkan hasil kedua model dan menandai segmen tanpa deteksi.')
    rows = fuse(read_predictions(output/'global'/(audio.stem+'.BirdNET.results.csv')),
        read_predictions(output/'sumatra'/(audio.stem+'.BirdNET.results.csv')),
        {n.split('_',1)[0] for n in global_labels}, {n.split('_',1)[0] for n in labels}, info['duration'])
    atomic_json(output/'inference-result.json', dict(model=manifest, duration=info['duration'], segments=rows))


def probe(root):
    # Use silent audio only to download/load the global backbone and verify both passes.
    import tempfile
    import wave
    from birdnet_analyzer.utils import ensure_model_exists
    ensure_model_exists(check_perch=False)
    with tempfile.TemporaryDirectory(prefix='eis-bird-probe-') as temp:
        temp = Path(temp)
        path = temp/'probe.wav'
        with wave.open(str(path),'wb') as audio:
            audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(48000); audio.writeframes(b'\0'*288000)
        infer(root, path, temp/'output')
    manifest, _ = installed_model(root, verify=True)
    atomic_json(root/'bird-ready.json', dict(id=manifest['id'], pipeline=PIPELINE))
    print('Model Sumatra sementara siap. WAV dan MP3 diproses pada CPU.', flush=True)


def watch_parent(pid):
    def run():
        if os.name == 'nt':
            import ctypes
            kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            kernel.OpenProcess.restype = ctypes.c_void_p
            kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
            kernel.CloseHandle.argtypes = [ctypes.c_void_p]
            handle = kernel.OpenProcess(0x100000, False, pid)
            if not handle: os._exit(2)
            try:
                if kernel.WaitForSingleObject(handle, 0xffffffff) == 0: os._exit(2)
            finally: kernel.CloseHandle(handle)
        else:
            while True:
                try: os.kill(pid, 0)
                except ProcessLookupError: os._exit(2)
                time.sleep(2)
    threading.Thread(target=run, daemon=True).start()


if __name__ == '__main__':
    try:
        command, root = sys.argv[1], Path(sys.argv[2]).resolve()
        if command == 'probe': probe(root)
        elif command == 'infer':
            if len(sys.argv)>5: watch_parent(int(sys.argv[5]))
            infer(root, Path(sys.argv[3]).resolve(), Path(sys.argv[4]).resolve())
        else: raise ValueError('Perintah inference tidak valid.')
    except Exception as exc:
        print(f'Inference gagal ({type(exc).__name__}): {exc}', file=sys.stderr, flush=True)
        sys.exit(1)
