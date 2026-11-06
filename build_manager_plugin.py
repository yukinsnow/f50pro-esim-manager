from pathlib import Path
P=Path(__file__).parent
(P/'build/transfer').mkdir(parents=True,exist_ok=True)
js=(P/'encrypt_payload.js').read_text()+'\n'+(P/'native-manager.js').read_text()
assert '</script' not in js.lower()
s='<!-- [KANO_PLUGIN_START] F50-9esim-Manager-v2 -->\n<script>\n'+js+'\n</script>\n<!-- [KANO_PLUGIN_END] F50-9esim-Manager-v2 -->\n'
(P/'F50-9esim-Manager.txt').write_text(s)
(P/'build/transfer/F50-9esim-Manager.txt').write_bytes(s.encode())
print('BYTES',len(s.encode()))
