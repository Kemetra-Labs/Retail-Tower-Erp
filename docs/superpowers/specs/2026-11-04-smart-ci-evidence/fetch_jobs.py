import json,subprocess,os,sys
from concurrent.futures import ThreadPoolExecutor
S=sys.argv[1]
R='repos/Kemetra-Labs/Retail-Tower-Erp'
prs=json.load(open(S+'/prs40.json'));heads={p['headRefName']:p['number'] for p in prs}
rs=json.load(open(S+'/runs.json'))
m=[r for r in rs if r['head_branch'] in heads and r['event'] in('pull_request','pull_request_target')]
os.makedirs(S+'/jobs',exist_ok=True)
def f(r):
    p=f"{S}/jobs/{r['id']}.json"
    if os.path.exists(p): return
    o=subprocess.run(['gh','api','--paginate',f"{R}/actions/runs/{r['id']}/jobs?per_page=100&filter=all",'--jq','.jobs[]|{id,name,run_attempt,status,conclusion,created_at,started_at,completed_at,runner_name,labels,run_id}'],capture_output=True,text=True)
    if o.returncode!=0: print('ERR',r['id'],o.stderr[:100]);return
    open(p,'w').write('['+','.join(l for l in o.stdout.splitlines() if l.strip())+']')
with ThreadPoolExecutor(8) as ex: list(ex.map(f,m))
print('done',len(m))
