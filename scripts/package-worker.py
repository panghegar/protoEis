"""Build an allowlisted, credential-free Windows worker download."""
import hashlib
import json
from pathlib import Path
import zipfile
ROOT=Path(__file__).resolve().parents[1]
FILES=['INSTALL.cmd','BUKA-LAUNCHER.cmd','UNINSTALL-LAUNCHER.py','install_launcher.py','launcher.py','launcher_core.py','worker.py','trainer.py','requirements.txt','PANDUAN.txt']
destination=ROOT/'frontend/public/downloads'
destination.mkdir(parents=True,exist_ok=True)
output=destination/'eis-worker-windows.zip'
with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as archive:
    for name in FILES:
        archive.write(ROOT/'worker'/name,'eis-worker/'+name)
manifest={'file':output.name,'bytes':output.stat().st_size,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),'files':FILES}
(destination/'worker-release.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
print('Paket worker siap; hanya source yang diizinkan, tanpa token, dataset pengguna, .venv, atau hasil training.')
