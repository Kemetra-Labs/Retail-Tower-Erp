import json,subprocess,os,sys
from concurrent.futures import ThreadPoolExecutor
S=sys.argv[1];R='repos/Kemetra-Labs/Retail-Tower-Erp'
with open(S+'/shas.json',encoding='utf-8') as f: shas=list(json.load(f)['shas'])
os.makedirs(S+'/cr_all',exist_ok=True)
def f(sha):
    p=f'{S}/cr_all/{sha}.json'
    if os.path.exists(p): return
    o=subprocess.run(['gh','api','--paginate',f'{R}/commits/{sha}/check-runs?per_page=100&filter=all','--jq','.check_runs[]|select(.name=="required" or .name=="gate/post" or .name=="gate/evaluate")|{id,name,status,conclusion,started_at,completed_at,output_title:.output.title}'],capture_output=True)
    if o.returncode!=0: print('ERR',sha,o.stderr[:100]);return
    with open(p,'w',encoding='utf-8') as fh: fh.write('['+','.join(l for l in o.stdout.decode('utf-8','replace').splitlines() if l.strip())+']')
with ThreadPoolExecutor(6) as ex: list(ex.map(f,shas))
print('done')
