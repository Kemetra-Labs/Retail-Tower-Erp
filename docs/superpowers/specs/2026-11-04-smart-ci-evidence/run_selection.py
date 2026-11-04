import json,sys,subprocess,collections
sys.path.insert(0,sys.argv[1]);import sel_lib as L
S=sys.argv[1]
prs=json.load(open(S+'/prs40.json'));shas=json.load(open(S+'/pr_shas.json'));base=json.load(open(S+'/pr_base.json'))
out={}
for n,ss in shas.items():
    for s in ss:
        b=base.get(s)
        if not b: continue
        plan,ch=L.evaluate(b,s)
        g=L.graph_of(b)
        paths=[]
        for e in plan['paths']:
            t=e['trusted']; jobs=set()
            if t['kind']=='product':
                for tier in t['tiers']: jobs|=g.tier_jobs(t['owner'],tier)
            elif t['kind']=='class':
                c=g.shared_class(t['owner'])
                jobs='ALL' if c['selects']=='all' else (set(['e2e/smoke']) if 'e2e' in c['selects'] else set())
            else: jobs='ALL'
            paths.append(dict(path=e['path'],kind=t['kind'],owner=t['owner'],tiers=e['tiers'],jobs=('ALL' if jobs=='ALL' else sorted(jobs)),cats=L.cat_of(e['path'])))
        rec=dict(pr=int(n),sha=s,base=b,n_changed=len(ch),needed=plan['needed_jobs'],select_all=plan['select_all'],select_all_reasons=plan['select_all_reasons'],
                 products={k:v['run'] for k,v in plan['products'].items()},policy_change=plan['policy_change'],gv=plan['graph_validation']['status'],paths=paths)
        # what-if drops
        wi={}
        for cat,f in L.CATS.items():
            p2,_=L.evaluate(b,s,drop=f); wi[cat]=p2['needed_jobs']
        p2,_=L.evaluate(b,s,drop=L.any_cat); wi['ALL_incidental']=p2['needed_jobs']; rec['sa_without_incidental']=p2['select_all']
        rec['whatif']=wi
        out[s]=rec
json.dump(out,open(S+'/selection.json','w'))
print(len(out))
