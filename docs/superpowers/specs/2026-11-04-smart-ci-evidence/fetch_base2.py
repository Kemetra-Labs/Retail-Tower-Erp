import json,subprocess,re,sys
S=sys.argv[1]
base=json.load(open(S+'/pr_base.json'))
prs=json.load(open(S+'/prs40.json'));heads={p['headRefName']:p['number'] for p in prs}
rs=json.load(open(S+'/runs.json'))
allsha={r['head_sha'] for r in rs if r['head_branch'] in heads and r['event']=='pull_request'}
for s in sorted(allsha-set(base)):
    for r in rs:
        if r['head_sha']==s and r['event']=='pull_request' and r['name'] in('backend-core','admin-console','erpnext-connector','e2e','contracts','project-graph'):
            j=[x for x in json.load(open(f"{S}/jobs/{r['id']}.json")) if x['name']=='plan']
            if not j: continue
            o=subprocess.run(['gh','api','--allow-escape-sequences',f"repos/Kemetra-Labs/Retail-Tower-Erp/actions/jobs/{j[0]['id']}/logs"],capture_output=True)
            if o.returncode!=0: raise SystemExit(f'log request failed for job {j[0]["id"]}: {o.stderr[:200]!r}')
            mm=re.search(rb'PR_BASE: ([0-9a-f]{40})',o.stdout)
            if mm: base[s]=mm.group(1).decode();print(s[:8],'via',r['name']);break
    else: print('still missing',s[:8],[ (r['name'],r['conclusion']) for r in rs if r['head_sha']==s and r['event']=='pull_request'][:12])
json.dump(base,open(S+'/pr_base.json','w'));print(len(base),len(allsha))
