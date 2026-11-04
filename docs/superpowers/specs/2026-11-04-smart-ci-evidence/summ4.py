import json,sys,collections,statistics as st,datetime as dt
S=sys.argv[1]
def ld(p):
    with open(p,encoding='utf-8') as f: return json.load(f)
T=lambda s:dt.datetime.strptime(s,'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc) if s else None
A=ld(S+'/analysis.json');rows=A['rows'];jobs=ld(S+'/jobs.json');D=ld(S+'/shas.json')
fullof={s[:10]:s for s in D['shas']}
jb=collections.defaultdict(list)
for j in jobs: jb[j['sha']].append(j)
fin=[r for r in rows if r['state']!='none']
def q(x,p): 
    x=sorted(x);return round(x[int(p*(len(x)-1))],1)
# ---- wall decomposition
print('== wall (finished shas, n=%d)'%len(fin))
spans=collections.defaultdict(list);crit=collections.Counter();pre=[];gate=[];tot=[]
for r in fin:
    s=fullof[r['sha']];push=T(D['shas'][s]['push'])
    wf=collections.defaultdict(list)
    for j in jb[s]:
        if j['conclusion'] in('success','failure') and j['completed'] and j['workflow']!='gate': wf[j['workflow']].append(T(j['completed']))
    ends={w:max(v) for w,v in wf.items()}
    for w,e in ends.items(): spans[w].append((e-push).total_seconds()/60)
    if ends:
        cw=max(ends,key=ends.get);crit[cw]+=1;last=ends[cw]
        pre.append((last-push).total_seconds()/60);gate.append((T(r['required_at'])-last).total_seconds()/60);tot.append(r['wall_min'])
print('push->last workflow end: median',round(st.median(pre),1),'p90',q(pre,.9));print('last workflow end->required: median',round(st.median(gate),1),'p90',q(gate,.9));print('push->required: median',round(st.median(tot),1),'p90',q(tot,.9),'max',max(tot))
print('critical workflow counts',crit.most_common())
for w,v in sorted(spans.items(),key=lambda kv:-st.median(kv[1])): print(' span push->workflow end',w,'n',len(v),'median',round(st.median(v),1),'p90',q(v,.9),'max',round(max(v),1))
for kind in('first','corrective'):
    w=[r['wall_min'] for r in rows if r['kind']==kind and r['wall_min'] is not None];print(kind,'wall n',len(w),'median',round(st.median(w),1),'mean',round(st.mean(w),1),'p90',q(w,.9),'sum',round(sum(w),1))
# ---- failures & reruns
print('== job failures (conclusion=failure), excluding gate')
fl=[j for j in jobs if j['conclusion']=='failure' and j['workflow']!='gate']
byj=collections.Counter(j['job'] for j in fl);print(byj.most_common())
print('shas with a failed job',len({j['sha'] for j in fl}),'failed gate/evaluate',sum(1 for j in jobs if j['job']=='gate/evaluate' and j['conclusion']=='failure'))
print('required states',collections.Counter(r['required'] for r in rows))
print('== reruns (run_attempt>1)')
for r in rows:
    if r['n_reruns_runs']: print(r['pr'],r['idx'],r['sha'],r['required'],'rerun runs',r['n_reruns_runs'],'rm_rerun_attempts',r['rm_rerun_attempts'])
rr=collections.defaultdict(lambda:collections.defaultdict(list))
for j in jobs:
    if j['run_attempt_latest']>1: rr[j['run_id']][j['job']].append((j['attempt'],j['conclusion']))
for rid,d in rr.items():
    for jn,l in d.items():
        l.sort()
        if any(c=='failure' for a,c in l) : print(' rerun run',rid,jn,l)
print('total rerun-attempt runner min',round(sum(r['rm_rerun_attempts'] for r in rows),1))
# failed job details with next-sha outcome
print('== failed shas detail')
for r in rows:
    if r['failed_jobs']:
        print(r['pr'],r['idx'],r['sha'],r['required'],r['failed_jobs'],'| next:',[ (x['idx'],x['required'],x['failed_jobs']) for x in rows if x['pr']==r['pr'] and x['idx']==r['idx']+1])
print('== gate failures')
for r in rows:
    if r['gate_failed']: print(r['pr'],r['idx'],r['sha'],r['required'],r['state'])
