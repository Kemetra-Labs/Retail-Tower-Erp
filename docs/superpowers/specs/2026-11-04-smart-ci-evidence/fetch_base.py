import json,subprocess,os,re,sys
from concurrent.futures import ThreadPoolExecutor
S=sys.argv[1]
prs=json.load(open(S+'/prs40.json'));heads={p['headRefName']:p['number'] for p in prs}
rs=json.load(open(S+'/runs.json'))
m=[r for r in rs if r['head_branch'] in heads and r['event']=='pull_request' and r['name']=='pos']
def f(r):
    jf=f"{S}/jobs/{r['id']}.json"
    j=[x for x in json.load(open(jf)) if x['name']=='plan']
    if not j: return r['head_sha'],None
    o=subprocess.run(['gh','api','--allow-escape-sequences',f"repos/Kemetra-Labs/Retail-Tower-Erp/actions/jobs/{j[0]['id']}/logs"],capture_output=True)
    mm=re.search(rb'PR_BASE: ([0-9a-f]{40})',o.stdout)
    return r['head_sha'],(mm.group(1).decode() if mm else None)
with ThreadPoolExecutor(6) as ex: res=list(ex.map(f,m))
d={}
for s,b in res:
    if b: d[s]=b
json.dump(d,open(S+'/pr_base.json','w'))
print(len(m),len(d))
