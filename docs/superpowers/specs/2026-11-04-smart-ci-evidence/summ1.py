import json,sys,collections,statistics as st
S=sys.argv[1]
def ld(p):
    with open(p,encoding='utf-8') as f: return json.load(f)
A=ld(S+'/analysis.json');rows=A['rows'];sel=ld(S+'/selection.json');D=ld(S+'/shas.json')
byfull={r['sha']:s for s in D['shas'] for r in rows if s.startswith(r['sha'])}
# validation predicted vs actual
ok=0;bad=[];n=0
for r in rows:
    s=byfull[r['sha']]
    if s not in sel: continue
    n+=1
    pred=set(sel[s]['needed']);act=set(r['actual_keys'])
    if r['state']=='none': continue
    sh={'pos/test-shard-1','pos/test-shard-2','pos/test-shard-3'}
    if pred&(sh|{'pos/test'}): pred|=sh|{'pos/test'}
    if act&(sh|{'pos/test'}): act|=sh|{'pos/test'}
    if pred==act: ok+=1
    else: bad.append((r['pr'],r['idx'],r['required'],sorted(pred-act),sorted(act-pred)))
print('validation',ok,'/',n)
for b in bad: print(b)
print(collections.Counter((r['kind'],r['state']) for r in rows))
tot=sum(r['runner_min'] for r in rows);print('total runner min',tot, 'hours',tot/60)
for k in('rm_success','rm_failure','rm_cancelled','rm_product','rm_plan','rm_gate','rm_always-selftest-secrets','rm_always-graph','rm_rerun_attempts'):
    print(k,round(sum(r[k] for r in rows),1))
for kind in('first','corrective'):
    rr=[r for r in rows if r['kind']==kind]
    w=[r['wall_min'] for r in rr if r['wall_min'] is not None]
    print(kind,len(rr),'runner',round(sum(r['runner_min'] for r in rr),1),'cancelled',round(sum(r['rm_cancelled'] for r in rr),1),'wall n',len(w),'sum',round(sum(w),1),'median',st.median(w),'mean',round(st.mean(w),1))
