"""Stage 1: join cached API data into jobs.csv / shas.csv / prs.csv + data.json (no git evaluator here)."""
import json,glob,os,sys,csv,subprocess,collections,datetime as dt
S=sys.argv[1]
WT=r'C:/Users/user/Documents/GitHub/Retail-Tower-Erp/.claude/worktrees/rt-946-ci-analysis-90480c'
def T(s): return dt.datetime.strptime(s,'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc) if s else None
def ld(p):
    with open(p,encoding='utf-8') as f: return json.load(f)
prs=ld(S+'/prs40.json');prn={p['number']:p for p in prs};heads={p['headRefName']:p['number'] for p in prs}
runs=[r for r in ld(S+'/runs.json') if r['head_branch'] in heads and r['event'] in('pull_request','pull_request_target')]
base=ld(S+'/pr_base.json')
GRAPH_JOBS={'pos/static','pos/test-shard-1','pos/test-shard-2','pos/test-shard-3','pos/test','pos/package-windows','pos/docs','pos/e2e-electron','admin/build-test','admin/e2e','bc/fast','bc/db-integration','bc/db-package','bc/oasdiff','bc/contracts-compat','bc/schemathesis','connector/unit-tests-and-lint','connector/bench','e2e/smoke','boundary-check','dependency-review','contracts/check'}
def key(name):
    if name.startswith('schemathesis shard'): return 'bc/schemathesis'
    if name=='connector/bench lane v16': return 'connector/bench'
    return name if name in GRAPH_JOBS else None
def overhead(name):
    if name=='plan': return 'plan'
    if name in('gate/evaluate','gate/post'): return 'gate'
    if name in('gitleaks/full-history','project-graph/selftest','release/selftest'): return 'always-selftest-secrets'
    if name in('boundary-check','dependency-review'): return 'always-graph'
    if name=='required': return 'required-noop'
    return None
jobs=[]
for r in runs:
    for j in ld(f"{S}/jobs/{r['id']}.json"):
        st,co,cr=T(j['started_at']),T(j['completed_at']),T(j['created_at'])
        dur=max(0.0,(co-st).total_seconds()) if st and co and j['conclusion']!='skipped' else 0.0
        q=max(0.0,(st-cr).total_seconds()) if st and cr and j['conclusion']!='skipped' else 0.0
        jobs.append(dict(pr=heads[r['head_branch']],sha=r['head_sha'],workflow=r['name'],event=r['event'],run_id=r['id'],run_attempt_latest=r['run_attempt'],
            job_id=j['id'],job=j['name'],key=key(j['name']) or '',cat=overhead(j['name']) or ('product' if key(j['name']) else 'other'),attempt=j['run_attempt'],
            conclusion=j['conclusion'] or 'none',created=j['created_at'],started=j['started_at'],completed=j['completed_at'],dur_s=dur,queue_s=q,
            runner=(j['labels'] or [''])[0]))
# per sha
shas=collections.defaultdict(dict)
for r in runs:
    d=shas[r['head_sha']]; d['pr']=heads[r['head_branch']]
    d.setdefault('push',r['created_at']) 
    if r['event']=='pull_request' and r['created_at']<d['push']: d['push']=r['created_at']
for s,d in shas.items():
    d['push']=min(r['created_at'] for r in runs if r['head_sha']==s)
    p=subprocess.run(['git','-C',WT,'rev-list','--parents','-n1',s],capture_output=True,text=True).stdout.split()
    d['parents']=p[1:]
    d['commit_time']=subprocess.run(['git','-C',WT,'show','-s','--format=%cI',s],capture_output=True,text=True).stdout.strip()
    d['subject']=subprocess.run(['git','-C',WT,'show','-s','--format=%s',s],capture_output=True,text=True,encoding='utf-8',errors='replace').stdout.strip()
    # main merged? second parent ancestor of origin/main
    d['main_sync']=False
    if len(d['parents'])>1:
        for par in d['parents'][1:]:
            if subprocess.run(['git','-C',WT,'merge-base','--is-ancestor',par,'origin/main']).returncode==0: d['main_sync']=True
    cr=f'{S}/cr_all/{s}.json'
    d['required']=None;d['required_all']=[]
    if os.path.exists(cr):
        rq=[c for c in ld(cr) if c['name']=='required']
        d['required_all']=rq
        done=sorted([c for c in rq if c['status']=='completed' and c['completed_at']],key=lambda c:c['completed_at'])
        succ=[c for c in done if c['conclusion']=='success']
        # first success if any, else first completed (failure); stale in_progress 'waiting' placeholders ignored
        d['required']=(succ[0] if succ else (done[0] if done else None))
    d['base']=base.get(s)
byPR=collections.defaultdict(list)
for s,d in shas.items(): byPR[d['pr']].append(s)
for n,l in byPR.items():
    l.sort(key=lambda s:shas[s]['push'])
    for i,s in enumerate(l): shas[s]['idx']=i; shas[s]['n_in_pr']=len(l); shas[s]['prev']=l[i-1] if i else None
json.dump(dict(shas=shas,byPR=byPR),open(S+'/shas.json','w'),default=str)
with open(S+'/jobs.csv','w',newline='',encoding='utf-8') as f:
    w=csv.DictWriter(f,fieldnames=list(jobs[0].keys()));w.writeheader();w.writerows(jobs)
json.dump(jobs,open(S+'/jobs.json','w'))
print(len(jobs),len(shas))
