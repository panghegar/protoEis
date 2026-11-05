import json
from pathlib import Path
import sys
import unittest
import zipfile
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'worker'))
from launcher_core import parse_start_uri,validate_config,config_worker_id,WorkerControl
IDENT='d3952fa7-6be7-45bc-978d-4d082f009ac5'
class LauncherTests(unittest.TestCase):
    def test_uri_is_only_device_id_not_command(self):
        self.assertEqual(parse_start_uri('eisworker://start/'+IDENT),IDENT)
        for uri in ['https://start/'+IDENT,'eisworker://setup/'+IDENT,'eisworker://start/'+IDENT+'?cmd=calc',
            'eisworker://start/'+IDENT+'#token=secret','eisworker://start/../../cmd.exe',
            'eisworker://start/'+IDENT+'"; calc.exe','eisworker://start/%22'+IDENT,'eisworker://start/'+IDENT+'/extra']:
            with self.subTest(uri=uri),self.assertRaises(ValueError):parse_start_uri(uri)

    def test_connection_cannot_inject_arguments_or_insecure_host(self):
        config={'apiUrl':'https://training.example/api','token':IDENT+'.'+'a'*64}
        self.assertEqual(config_worker_id(validate_config(config)),IDENT)
        for value in ['http://external.example/api','https://user:pw@training.example/api','https://training.example/api?cmd=run','file:///tmp/api']:
            with self.subTest(value=value),self.assertRaises(ValueError):validate_config({**config,'apiUrl':value})
        with self.assertRaises(ValueError):validate_config({**config,'command':'calc.exe'})
        with self.assertRaises(ValueError):validate_config({**config,'token':'";calc.exe'})

    def test_wrong_device_never_starts_process(self):
        config={'apiUrl':'https://training.example/api','token':IDENT+'.'+'a'*64}
        with patch('launcher_core.read_config',return_value=config),patch('launcher_core.subprocess.Popen') as process:
            with self.assertRaises(ValueError):WorkerControl(ROOT/'worker').start('a3952fa7-6be7-45bc-978d-4d082f009ac5')
            process.assert_not_called()

    def test_download_matches_sources_and_has_no_credentials(self):
        manifest=json.loads((ROOT/'frontend/public/downloads/worker-release.json').read_text())
        with zipfile.ZipFile(ROOT/'frontend/public/downloads/eis-worker-windows.zip') as archive:
            self.assertEqual(set(archive.namelist()),{'eis-worker/'+name for name in manifest['files']})
            for name in manifest['files']:
                self.assertEqual(archive.read('eis-worker/'+name),(ROOT/'worker'/name).read_bytes())
            for name in archive.namelist():
                self.assertNotIn('worker.json',name)
                self.assertNotIn('.venv',name)
                self.assertNotIn('runs/',name)

if __name__=='__main__':unittest.main()
