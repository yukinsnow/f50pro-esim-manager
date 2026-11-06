"""Build statically linked aarch64 Linux LPAC for Android kernel userspace."""
from pathlib import Path
import subprocess
P=Path(__file__).parent; src=P/'vendor/lpac'; out=P/'build/engine';out.mkdir(parents=True,exist_ok=True)
# Static loader: no dlopen/glibc runtime dependency on Android.
(out/'static_loader.c').write_text('''#include <string.h>
#include <driver.h>
#include <euicc-driver-loader.h>
extern const struct euicc_driver apdu_stdio_if, http_stdio_if;
struct euicc_apdu_interface euicc_driver_interface_apdu;
struct euicc_http_interface euicc_driver_interface_http;
int euicc_driver_init(const char*a,const char*h){return apdu_stdio_if.init(&euicc_driver_interface_apdu)||http_stdio_if.init(&euicc_driver_interface_http);}
void euicc_driver_fini(void){}
int euicc_driver_list(int a,char**v){return 0;}
int euicc_driver_main_apdu(int a,char**v){return 0;}
int euicc_driver_main_http(int a,char**v){return 0;}
''')
for kind in ['apdu','http']:
 s=(src/f'driver/{kind}/stdio.c').read_text().replace('DRIVER_INTERFACE =',f'const struct euicc_driver {kind}_stdio_if =')
 (out/f'{kind}_stdio.c').write_text(s)
incs=[P/'vendor',src,src/'src',src/'utils',src/'driver',src/'cjson-ext',P/'vendor/cjson']
files=list((src/'euicc').glob('*.c'))+list((src/'src').rglob('*.c'))+[P/'vendor/cjson/cJSON.c',src/'cjson-ext/cjson-ext/cJSON_ex.c',src/'utils/lpac/utils.c',out/'static_loader.c',out/'apdu_stdio.c',out/'http_stdio.c']
# Private input FD prevents activation/confirmation codes appearing in LPAC argv.
(out/'main.c').write_text('''#include <stdlib.h>\n#include <stdio.h>\n#include "lpac.h"\nint main(int argc,char**argv){char*fd=getenv("F50_LPAC_ARG_FD");if(!fd)return lpac_main(argc,argv);FILE*f=fdopen(atoi(fd),"r");if(!f)return 1;char*args[32]={argv[0]};int n=1;while(n<31){char*s=NULL;size_t z=0;ssize_t r=getdelim(&s,&z,0,f);if(r<0){free(s);break;}args[n++]=s;}fclose(f);return lpac_main(n,args);}\n''')
files=[f for f in files if f!=src/'src/main.c']+[out/'main.c']
cmd=['gcc','-static','-Os','-ffunction-sections','-fdata-sections','-Wl,--gc-sections','-DLPAC_VERSION="2.3.0-f50"']+[f'-I{x}' for x in incs]+[str(f) for f in files]+['-lm','-o',str(out/'lpac')]
subprocess.run(cmd,check=True)
subprocess.run(['strip',str(out/'lpac')],check=True)
print(out/'lpac')
