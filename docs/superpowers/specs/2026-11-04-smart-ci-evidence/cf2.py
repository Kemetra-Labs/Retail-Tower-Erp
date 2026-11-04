"""Counterfactual variants for corrective pushes (ESTIMATES).
V1 head-level anchor (last head with required=success), naive anchor->head diff        [already in analysis.json]
V2 head-level anchor, anchor->head diff restricted to paths the PR itself changes vs base (drops main-origin changes pulled by a merge)
V3 job-level anchor: job J skippable if J succeeded on an earlier head of the PR and nothing changed since that head would select J (naive diff)
V4 job-level anchor with the V2 diff restriction
"""
import json,sys,collections,statistics as st,datetime as dt,csv
S=sys.argv[1];sys.path.insert(0,S)
import sel_lib as L
def ld(p):
    with open(p,encoding='utf-8') as f: return json.load(f)
T=lambda s:dt.datetime.strptime(s,'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc) if s else None
A=ld(S+'/analysis.json');rows=A['rows'];D=ld(S+'/shas.json');jobs=ld(S+'/jobs.json');shas=D['shas'];byPR=D['byPR']
full={s[:10]:s for s in shas};R={r['sha']:r for r in rows}
jb=collections.defaultdict(list)
for j in jobs: jb[j['sha']].append(j)
SKIPK=('boundary-check','dependency-review')
def pr_own_paths(base,head): return {c.path for c in L.diff(base,head)}
cache={}
def needed(base,anchor,head,restrict):
    k=(base,anchor,head,restrict)
    if k not in cache:
        drop=None
        if restrict:
            own=pr_own_paths(base,head)
            drop=lambda p:p not in own
        plan,_=L.evaluate(base,head,change_base=anchor,drop=drop)
        cache[k]=set(plan['needed_jobs'])
    return cache[k]
def succeeded(s):
    d=collections.defaultdict(list)
    for j in jb[s]:
        if j['key']: d[j['key']].append(j['conclusion'])
    out=set()
    # J succeeded on sha if every executed job instance of that key (latest attempt) succeeded; use: has success and no failure/cancelled in latest attempt
    byk=collections.defaultdict(list)
    for j in jb[s]:
        if j['key']: byk[j['key']].append(j)
    for k,l in byk.items():
        la=[j for j in l if j['attempt']==j['run_attempt_latest']]
        ex=[j for j in la if j['conclusion']!='skipped']
        if ex and all(j['conclusion']=='success' for j in ex): out.add(k)
    return out
out=[]
for r in rows:
    if r['idx']==0: continue
    s=full[r['sha']];d=shas[s];pr=r['pr'];order=byPR[str(pr)];i=order.index(s)
    if not d['base']: continue
    rec=dict(sha=r['sha'],pr=pr,idx=r['idx'],main_sync=r['main_sync'],state=r['state'],runner_min=r['runner_min'],wall_min=r['wall_min'])
    # V2 head-level
    green=[x for x in order[:i] if R[x[:10]]['state']=='green']
    for var,restrict in(('V2',True),):
        if green:
            anc=green[-1];between=order[order.index(anc)+1:i]
            fk={j['key'] for b in between for j in jb[b] if j['conclusion']=='failure' and j['key']}
            n=needed(d['base'],anc,s,restrict)|fk
            rec[var+'_saved']=round(sum(j['dur_s'] for j in jb[s] if j['key'] and j['key'] not in n and j['key'] not in SKIPK)/60,2)
            rec[var+'_skipkeys']=sorted({j['key'] for j in jb[s] if j['key'] and j['key'] not in n and j['key'] not in SKIPK})
        else: rec[var+'_saved']=0.0;rec[var+'_skipkeys']=[]
    # job-level
    for var,restrict in(('V3',False),('V4',True)):
        sv=0.0;skipped=collections.Counter()
        runkeys={j['key'] for j in jb[s] if j['key'] and j['conclusion']!='skipped' and j['key'] not in SKIPK}
        for J in runkeys:
            cand=None
            for jx in range(i-1,-1,-1):
                if J in succeeded(order[jx]): cand=order[jx];break
            if cand is None: continue
            n=needed(d['base'],cand,s,restrict)
            if J not in n:
                t=sum(j['dur_s'] for j in jb[s] if j['key']==J)/60;sv+=t;skipped[J]+=t
        rec[var+'_saved']=round(sv,2);rec[var+'_by_job']=dict(skipped);rec[var+'_skipkeys']=sorted(skipped)
    out.append(rec)
def wall(o,skipk):
    s=full[o['sha']];d=shas[s];req=d['required']
    if not(req and req['completed_at']) or o['wall_min'] is None: return None
    allj=[j for j in jb[s] if j['conclusion']!='skipped' and j['completed'] and j['cat'] not in('gate','required-noop')]
    keep=[j for j in allj if not(j['key'] in skipk)]
    if not keep: return None
    g=(T(req['completed_at'])-max(T(j['completed']) for j in allj)).total_seconds()
    return o['wall_min']-((max(T(j['completed']) for j in keep)-T(d['push'])).total_seconds()+g)/60
for o in out:
    for v in('V2','V4'): o[v+'_wall_saved']=wall(o,set(o[v+'_skipkeys']))
json.dump(out,open(S+'/cf2.json','w'))
for v in('V2','V4'):
    w=[o[v+'_wall_saved'] for o in out if o[v+'_wall_saved'] is not None]
    print(v,'wall-estimable pushes',len(w),'median wall saved',round(st.median(w),2),'mean',round(st.mean(w),2),'sum',round(sum(w),1),'pushes with >=2 min saved',sum(1 for x in w if x>=2),'>=5 min',sum(1 for x in w if x>=5),'median actual wall of those',round(st.median([o['wall_min'] for o in out if o[v+'_wall_saved'] is not None]),1))
rm=sum(o['runner_min'] for o in out);tot=sum(r['runner_min'] for r in rows)
print('corrective pushes (with CI)',len(out),'runner-min',round(rm,1))
for v in('V2','V3','V4'):
    sv=sum(o[v+'_saved'] for o in out);n=sum(1 for o in out if o[v+'_saved']>0.5)
    gated=sum(o[v+'_saved'] for o in out if o['state']!='none');
    print(v,'saved',round(sv,1),'= %.1f%% of corrective, %.1f%% of all CI; pushes with savings %d; saved on pushes that completed required: %.1f'%(100*sv/rm,100*sv/tot,n,gated))
for v in('V3','V4'):
    c=collections.Counter()
    for o in out:
        for k,x in o[v+'_by_job'].items(): c[k]+=x
    print(v,'by job',[(k,round(x,1)) for k,x in c.most_common(10)])
with open(S+'/counterfactual_variants.csv','w',newline='',encoding='utf-8') as f:
    w=csv.writer(f);w.writerow(['sha','pr','idx','main_sync','state','runner_min','wall_min','V2_saved','V3_saved','V4_saved'])
    for o in out: w.writerow([o['sha'],o['pr'],o['idx'],o['main_sync'],o['state'],o['runner_min'],o['wall_min'],o['V2_saved'],o['V3_saved'],o['V4_saved']])
