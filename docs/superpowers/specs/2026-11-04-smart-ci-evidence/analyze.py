import json,sys,csv,collections,statistics as st,datetime as dt
S=sys.argv[1];sys.path.insert(0,S)
import sel_lib as L
def ld(p):
    with open(p,encoding='utf-8') as f: return json.load(f)
def T(s): return dt.datetime.strptime(s,'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc) if s else None
D=ld(S+'/shas.json');shas=D['shas'];byPR=D['byPR'];jobs=ld(S+'/jobs.json');sel=ld(S+'/selection.json');prs={p['number']:p for p in ld(S+'/prs40.json')}
min_=lambda x:x/60.0
jb=collections.defaultdict(list)
for j in jobs: jb[j['sha']].append(j)
# -- reviews/comments
events=collections.defaultdict(list)  # pr -> (time,kind,user)
for n in prs:
    for x in ld(f'{S}/pr_reviews/{n}.json'):
        if x['submitted_at']:
            k='bot_review' if x['type']=='Bot' else 'owner_review'
            events[n].append((x['submitted_at'],k,x['user']))
    for x in ld(f'{S}/pr_comments/{n}.json'):
        k='bot_review' if x['type']=='Bot' else 'owner_review'; events[n].append((x['created_at'],k+'_inline',x['user']))
    for x in ld(f'{S}/issue_comments/{n}.json'):
        k='bot_summary' if x['type']=='Bot' else 'owner_comment'; events[n].append((x['created_at'],k,x['user']))
# -- per sha metrics
rows=[]
for s,d in shas.items():
    js=jb[s];req=d['required']
    push=T(d['push'])
    m=dict(sha=s[:10],pr=d['pr'],idx=d['idx'],n_in_pr=d['n_in_pr'],kind='first' if d['idx']==0 else 'corrective',push=d['push'],main_sync=d['main_sync'],n_parents=len(d['parents']),
           subject=d['subject'][:70],required=(req['conclusion'] if req else 'none'),required_at=(req['completed_at'] if req else ''))
    m['wall_min']=round(min_((T(req['completed_at'])-push).total_seconds()),2) if req and req['completed_at'] else None
    tot=collections.Counter();cat=collections.Counter()
    for j in js:
        tot[j['conclusion']]+=j['dur_s'];cat[j['cat']]+=j['dur_s']
    m['runner_min']=round(min_(sum(tot.values())),2)
    for c in('success','failure','cancelled'): m['rm_'+c]=round(min_(tot[c]),2)
    for c in('product','plan','gate','always-selftest-secrets','always-graph','required-noop','other'): m['rm_'+c]=round(min_(cat[c]),2)
    m['rm_rerun_attempts']=round(min_(sum(j['dur_s'] for j in js if j['attempt']<j['run_attempt_latest'])),2)
    m['n_reruns_runs']=len({j['run_id'] for j in js if j['run_attempt_latest']>1})
    nonskip=[j for j in js if j['conclusion']!='skipped' and j['completed'] and j['cat'] not in('gate','required-noop')]
    last=max(nonskip,key=lambda j:j['completed']) if nonskip else None
    m['last_job']=(last['workflow']+':'+last['job']) if last else ''
    m['last_job_at']=last['completed'] if last else ''
    m['failed_jobs']=';'.join(sorted({j['job'] for j in js if j['conclusion']=='failure' and j['cat']!='gate'}))
    m['gate_failed']=any(j['job']=='gate/evaluate' and j['conclusion']=='failure' for j in js)
    m['actual_keys']=sorted({j['key'] for j in js if j['key'] and j['conclusion'] in ('success','failure')})
    m['state']='green' if (req and req['conclusion']=='success') else ('red' if (req and req['conclusion']) else 'none')
    if d['idx']>0:
        prevpush=T(shas[d['prev']]['push'])
        ev=[e for e in events[d['pr']] if prevpush<=T(e[0])<push]
        m['after_bot_review']=any(e[1] in('bot_review','bot_review_inline') for e in ev)
        m['after_bot_any']=any(e[1].startswith('bot') for e in ev)
        m['after_owner_review']=any(e[1].startswith('owner_review') for e in ev)
        m['n_bot_review_events']=sum(1 for e in ev if e[1] in('bot_review','bot_review_inline'))
        m['gap_prev_push_min']=round((push-prevpush).total_seconds()/60,1)
        bt=[T(e[0]) for e in ev if e[1] in('bot_review','bot_review_inline')]
        m['lag_bot_review_to_push_min']=round((push-min(bt)).total_seconds()/60,1) if bt else None
    else:
        m['after_bot_review']=m['after_bot_any']=m['after_owner_review']=False;m['n_bot_review_events']=0;m['gap_prev_push_min']=None;m['lag_bot_review_to_push_min']=None
    rows.append(m)
rows.sort(key=lambda m:(m['pr'],m['idx']))
R={m['sha']:m for m in rows}
byfull={s[:10]:s for s in shas}
# ---- counterfactual anchor
cf=[]
SKIPK=('boundary-check','dependency-review')
for m in rows:
    if m['idx']==0: continue
    s=byfull[m['sha']];d=shas[s];pr=m['pr'];order=byPR[str(pr)]
    prior=[x for x in order[:m['idx']]]
    green=[x for x in prior if R[x[:10]]['state']=='green']
    rec=dict(sha=m['sha'],pr=pr,idx=m['idx'],main_sync=m['main_sync'],after_bot_review=m['after_bot_review'],required=m['required'],wall_min=m['wall_min'],runner_min=m['runner_min'],anchor=None)
    if not d['base']: cf.append(dict(rec,note='no base (no CI)'));continue
    if not green:
        cf.append(dict(rec,note='no prior green head: anchor=main, no change')); continue
    anchor=green[-1];rec['anchor']=anchor[:10];rec['anchor_dist']=order.index(s)-order.index(anchor)
    between=order[order.index(anchor)+1:order.index(s)]
    failed_keys=set()
    for b in between:
        for j in jb[b]:
            if j['conclusion']=='failure' and j['key']: failed_keys.add(j['key'])
    plan,ch=L.evaluate(d['base'],s,change_base=anchor)
    cfset=set(plan['needed_jobs'])|failed_keys
    act=sel[s]['needed'] if s in sel else None
    rec.update(n_changed_anchor=len(ch),n_changed_actual=sel[s]['n_changed'] if s in sel else None,cf_sel_all=plan['select_all'],actual_sel_all=sel[s]['select_all'] if s in sel else None,
               cf_jobs=sorted(cfset),n_cf=len(cfset),n_actual=len(act) if act else None,failed_between=sorted(failed_keys))
    js=jb[s]
    saved=sum(j['dur_s'] for j in js if j['key'] and j['key'] not in cfset and j['key'] not in SKIPK)
    saved_ex=sum(j['dur_s'] for j in js if j['key'] and j['key'] not in cfset and j['conclusion']!='cancelled' and j['key'] not in SKIPK)
    rec['saved_runner_min']=round(min_(saved),2);rec['saved_runner_min_excl_cancelled']=round(min_(saved_ex),2)
    req=d['required']
    if req and req['completed_at']:
        keep=[j for j in js if j['conclusion']!='skipped' and j['completed'] and j['cat'] not in('gate','required-noop') and (not j['key'] or j['key'] in cfset or j['key'] in SKIPK)]
        allj=[j for j in js if j['conclusion']!='skipped' and j['completed'] and j['cat'] not in('gate','required-noop')]
        if keep and allj:
            lastall=max(T(j['completed']) for j in allj);lastcf=max(T(j['completed']) for j in keep)
            g=(T(req['completed_at'])-lastall).total_seconds()
            wallcf=(lastcf-T(d['push'])).total_seconds()+g
            rec['wall_cf_min']=round(wallcf/60,2);rec['wall_saved_min']=round(m['wall_min']-wallcf/60,2)
    cf.append(rec)
json.dump(dict(rows=rows,cf=cf),open(S+'/analysis.json','w'),default=str)
with open(S+'/shas.csv','w',newline='',encoding='utf-8') as f:
    keys=[k for k in rows[0] if k!='actual_keys']
    w=csv.DictWriter(f,fieldnames=keys,extrasaction='ignore');w.writeheader();w.writerows(rows)
with open(S+'/counterfactual.csv','w',newline='',encoding='utf-8') as f:
    keys=sorted({k for r in cf for k in r}|{'sha'});w=csv.DictWriter(f,fieldnames=keys);w.writeheader()
    for r in cf: w.writerow({k:(';'.join(v) if isinstance(v,list) else v) for k,v in r.items()})
print(len(rows),len(cf))
