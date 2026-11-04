import json,sys,collections,statistics as st,csv
S=sys.argv[1]
def ld(p):
    with open(p,encoding='utf-8') as f: return json.load(f)
A=ld(S+'/analysis.json');rows=A['rows'];cf=A['cf'];jobs=ld(S+'/jobs.json')
R={r['sha']:r for r in rows}
N=len(rows);fin=[r for r in rows if r['state']!='none']
term={}
for r in rows:
    if r['pr'] not in term or r['idx']>term[r['pr']]['idx']: term[r['pr']]=r
termset={(r['pr'],r['idx']) for r in term.values()}
tot=sum(r['runner_min'] for r in rows)
tr=sum(r['runner_min'] for r in rows if (r['pr'],r['idx']) in termset)
print('runner total',round(tot,1),'terminal heads',round(tr,1),'non-terminal',round(tot-tr,1),'pct nonterm',round(100*(tot-tr)/tot,1))
print('shas w/o required',sum(1 for r in rows if r['state']=='none'),'of',N)
# cancelled share
print('cancelled min',round(sum(r['rm_cancelled'] for r in rows),1),'pct',round(100*sum(r['rm_cancelled'] for r in rows)/tot,1))
# ---- job summary
js=collections.defaultdict(lambda:dict(n=0,rm=0.0,durs=[],q=[],shas=set(),cancel_rm=0.0,fail=0,ok=0,canc=0,runner=set()))
for j in jobs:
    if j['conclusion']=='skipped': continue
    k=j['key'] or j['job']
    if j['job'].startswith('schemathesis shard'): k='bc/schemathesis (shards 0-3 matrix)'
    if j['job']=='connector/bench lane v16': k='connector/bench lane v16 (real work)'
    if j['key']=='bc/schemathesis' and not j['job'].startswith('schemathesis shard'): k='bc/schemathesis (aggregator)'
    if j['job']=='connector/bench' : k='connector/bench (aggregator)'
    d=js[k]
    executed=j['conclusion'] in('success','failure') or (j['conclusion']=='cancelled' and j['dur_s']>0)
    if not executed: continue
    d['n']+=1;d['rm']+=j['dur_s']/60;d['shas'].add(j['sha']);d['runner'].add(j['runner'])
    if j['conclusion']=='success': d['durs'].append(j['dur_s']/60);d['ok']+=1
    if j['conclusion']=='failure': d['fail']+=1
    if j['conclusion']=='cancelled': d['canc']+=1;d['cancel_rm']+=j['dur_s']/60
    d['q'].append(j['queue_s']/60)
out=[]
for k,d in js.items():
    dd=sorted(d['durs'])
    out.append(dict(job=k,executions=d['n'],shas=len(d['shas']),pct_of_shas=round(100*len(d['shas'])/N,1),runner_min=round(d['rm'],1),pct_of_total=round(100*d['rm']/tot,1),
        cancelled_runner_min=round(d['cancel_rm'],1),ok=d['ok'],fail=d['fail'],cancelled=d['canc'],med_success_min=round(st.median(dd),2) if dd else None,
        p90_success_min=round(dd[int(0.9*(len(dd)-1))],2) if dd else None,max_success_min=round(max(dd),2) if dd else None,med_queue_min=round(st.median(d['q']),2),runner=','.join(sorted(d['runner']))))
out.sort(key=lambda x:-x['runner_min'])
with open(S+'/job_summary.csv','w',newline='',encoding='utf-8') as f:
    w=csv.DictWriter(f,fieldnames=list(out[0]));w.writeheader();w.writerows(out)
for o in out: print(o)
# ---- critical path: last finishing job among finished shas (excl cancelled)
c=collections.Counter(r['last_job'] for r in fin);print('critical path last job (finished shas)',c.most_common())
# wall decomposition for finished shas: push->last job, last job -> required
