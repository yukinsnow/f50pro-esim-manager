from pathlib import Path
import hashlib, shutil, tarfile
P=Path(__file__).resolve().parents[1]
D=P/'dist'; D.mkdir(exist_ok=True)
R=P/'build/package'; R.mkdir(parents=True,exist_ok=True)
for n,src in [('manager',P/'build/engine/manager'),('lpac',P/'build/engine/lpac'),('manager.sh',P/'manager.sh'),('install.sh',P/'install.sh')]:
 shutil.copy2(src,R/n)
(R/'SHA256SUMS').write_text(''.join(hashlib.sha256((R/n).read_bytes()).hexdigest()+'  '+n+'\n' for n in ['manager','lpac','manager.sh','install.sh']))
archive=D/'f50pro-esim-manager-v0.2.0-alpha.1.tar.gz'
with tarfile.open(archive,'w:gz') as t:
 for f in sorted(R.iterdir()):t.add(f,arcname='device/'+f.name)
 for n in ['README.md','LICENSE','F50-9esim-Manager.txt']:t.add(P/n,arcname=n)
 for n in ['vendor/lpac/LICENSES','vendor/lpac/euicc/LICENSE','vendor/lpac/driver/LICENSE','vendor/lpac/src/LICENSE','vendor/cjson/LICENSE']:
  t.add(P/n,arcname=n)
source=D/'f50pro-esim-manager-source-v0.2.0-alpha.1.tar.gz'
with tarfile.open(source,'w:gz') as t:
 for f in sorted(P.rglob('*')):
  rel=f.relative_to(P)
  if f.is_file() and not any(x in rel.parts for x in ['.git','build','dist','__pycache__']):t.add(f,arcname=str(Path('source')/rel),recursive=False)
for n in ['F50-9esim-Manager.txt']:shutil.copy2(P/n,D/n)
(D/'SHA256SUMS').write_text(''.join(hashlib.sha256(f.read_bytes()).hexdigest()+'  '+f.name+'\n' for f in sorted(D.iterdir()) if f.is_file() and f.name!='SHA256SUMS'))
print(archive,source)
