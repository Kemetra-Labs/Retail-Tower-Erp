import json,sys,collections,statistics as st,subprocess,re
S=sys.argv[1];sys.path.insert(0,S)
import sel_lib as L
def ld(p):
    with open(p,encoding='utf-8') as f: return json.load(f)
A=ld(S+'/analysis.json');rows=A['rows'];D=ld(S+'/shas.json');shas=D['shas'];byPR=D['byPR'];jobs=ld(S+'/jobs.json');sel=ld(S+'/selection.json');runs=ld(S+'/runs.json')
full={s[:10]:s for s in shas};R={r['sha']:r for r in rows}
jb=collections.defaultdict(list)
for j in jobs: jb[j['sha']].append(j)
SKIPK=('boundary-check','dependency-review')
tot=sum(r['runner_min'] for r in rows)
print('### 1 validation (gated heads only)')
SH={'pos/test-shard-1','pos/test-shard-2','pos/test-shard-3','pos/test'}
ok=bad=0;badl=[]
for r in rows:
    s=full[r['sha']]
    if s not in sel or r['state']=='none': continue
    pred=set(sel[s]['needed']);act=set(r['actual_keys'])
    if pred&SH: pred|=SH
    if act&SH: act|=SH
    if pred==act: ok+=1
    else:
        bad+=1
        miss=sorted(pred-act)
        concl={k:sorted({j['conclusion'] for j in jb[s] if j['key']==k}) for k in miss}
        badl.append((r['pr'],r['idx'],r['state'],concl,sorted(act-pred)))
print('gated heads compared',ok+bad,'exact match',ok,'mismatch',bad)
for b in badl: print('  ',b)
print(subprocess.run(['git','-C',L.WT,'log','origin/main','--since=2026-10-31','--oneline','--','tools/project-graph'],capture_output=True,text=True).stdout or '(no commits touching tools/project-graph since 2026-10-31)')
print('### 2 strict bot attribution')
prs=ld(S+'/prs40.json')
bot_inline=collections.defaultdict(list);bot_rev=collections.defaultdict(list)
for p in prs:
    n=p['number']
    for x in ld(f'{S}/pr_comments/{n}.json'):
        if x['type']=='Bot': bot_inline[n].append(x)
    for x in ld(f'{S}/pr_reviews/{n}.json'):
        if x['type']=='Bot': bot_rev[n].append(x)
import datetime as dt
T=lambda s:dt.datetime.strptime(s,'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc)
cor=[r for r in rows if r['idx']>0]
strictA=strictB=pure_main=0;rowsout=[]
for r in cor:
    s=full[r['sha']];d=shas[s];prev=d['prev'];base=d['base']
    prevpush=T(shas[prev]['push']);push=T(d['push'])
    if not base: rowsout.append(dict(sha=r['sha'],pure_main=False,strictA=False,strictB=False));continue
    own={c.path for c in L.diff(base,s)}
    since={c.path for c in L.diff(prev,s)}
    pr_changes_since=own&since
    pure=r['main_sync'] and not pr_changes_since
    # A: inline bot comment since prev push on a file touched by this push (PR's own change since prev)
    a=any(prevpush<=T(x['created_at'])<push and x['path'] in pr_changes_since for x in bot_inline[r['pr']])
    # B: bot review whose commit_id == previous head (full sha), posted before this push, and push is not a pure main merge
    b=(not pure) and any(x['commit_id']==prev and x.get('submitted_at') and T(x['submitted_at'])<push for x in bot_rev[r['pr']])
    strictA+=a;strictB+=b;pure_main+=pure
    rowsout.append(dict(sha=r['sha'],pr=r['pr'],idx=r['idx'],pure_main=pure,strictA=a,strictB=b,main_sync=r['main_sync'],runner_min=r['runner_min'],n_pr_paths_changed_since_prev=len(pr_changes_since)))
print('corrective',len(cor),'| pure main-merge (no PR-own path changed since previous head):',pure_main,'runner-min',round(sum(o['runner_min'] for o in rowsout if o.get('pure_main')),1))
print('strict A (bot inline comment on a file this push changed, posted since prev push):',strictA,'runner-min',round(sum(o['runner_min'] for o in rowsout if o.get('strictA')),1))
print('strict B (bot review on previous head, push not a pure main merge):',strictB,'runner-min',round(sum(o['runner_min'] for o in rowsout if o.get('strictB')),1))
either=[o for o in rowsout if (o.get('strictA') or o.get('strictB'))]
print('A or B:',len(either),'runner-min',round(sum(o['runner_min'] for o in either),1),'; neither strict and not pure-main:',sum(1 for o in rowsout if not o.get('strictA') and not o.get('strictB') and not o.get('pure_main')))
rm_pure=sum(o['runner_min'] for o in rowsout if o.get('pure_main'))
json.dump(rowsout,open(S+'/corrective_attribution.json','w'))
import csv
with open(S+'/corrective_attribution.csv','w',newline='',encoding='utf-8') as f:
    w=csv.DictWriter(f,fieldnames=sorted({k for o in rowsout for k in o}));w.writeheader();w.writerows(rowsout)
print('### 3 docs split what-if')
SUB={
 'bc_docs(services/backend-core/docs/**)':lambda p:p.startswith('services/backend-core/docs/'),
 'bc_changelog_d':lambda p:p.startswith('services/backend-core/changelog.d/'),
 'bc_deploy_README(deploy-security tier)':lambda p:p=='services/backend-core/deploy/README.md',
 'system/releases/README.md(system class)':lambda p:p=='system/releases/README.md',
 'pos_docs(low tier)':lambda p:p.startswith('apps/pos/docs/'),
 'admin_docs(low tier)':lambda p:p.startswith('apps/admin-console/docs/'),
 'other_md':lambda p:p.endswith('.md') and not any(f(p) for k,f in list(SUBX.items()) ) if False else False,
}
SUBX={}
res={}
for name,f in SUB.items():
    if name=='other_md': continue
    nsha=0;sv=0.0;prs_=set();present=0
    for s,v in sel.items():
        if any(f(p['path']) for p in v['paths']): present+=1
        p2,_=L.evaluate(v['base'],s,drop=f);n2=set(p2['needed_jobs'])
        if n2!=set(v['needed']):
            nsha+=1;prs_.add(v['pr'])
            sv+=sum(j['dur_s'] for j in jb[s] if j['key'] and j['key'] not in n2 and j['key'] not in SKIPK)/60
    print(name,'| present in',present,'shas | changes selection in',nsha,'shas /',len(prs_),'PRs | runner-min on deselected jobs',round(sv,1))
    res[name]=(nsha,round(sv,1))
bcd=lambda p:p.startswith('services/backend-core/docs/') or p.startswith('services/backend-core/changelog.d/')
nsha=0;sv=0.0
for s,v in sel.items():
    p2,_=L.evaluate(v['base'],s,drop=bcd);n2=set(p2['needed_jobs'])
    if n2!=set(v['needed']): nsha+=1;sv+=sum(j['dur_s'] for j in jb[s] if j['key'] and j['key'] not in n2 and j['key'] not in SKIPK)/60
print('BC docs+changelog.d together: selection changes in',nsha,'shas; runner-min',round(sv,1),'=%.1f%% of total'%(100*sv/tot))
print('### 4 main parents green on main push CI?')
push={}
for r in runs:
    if r['event']=='push' and r['head_branch']=='main': push.setdefault(r['head_sha'],[]).append((r['name'],r['conclusion']))
sync=[r for r in rows if r['main_sync']]
chk=0;green=0;missing=0;notgreen=[]
for r in sync:
    s=full[r['sha']];d=shas[s]
    for par in d['parents'][1:]:
        if subprocess.run(['git','-C',L.WT,'merge-base','--is-ancestor',par,'origin/main']).returncode!=0: continue
        chk+=1
        # main commit may be older than window or a non-squash commit; find push runs on that sha, else nearest ancestor with runs
        rs=push.get(par)
        if rs is None: missing+=1;continue
        core=[c for n,c in rs if n in('pos','admin-console','backend-core','erpnext-connector','contracts','e2e','project-graph')]
        if core and all(c=='success' for c in core): green+=1
        else: notgreen.append((r['pr'],r['idx'],par[:8],rs))
print('main-merge parents',chk,'with push-CI runs found',chk-missing,'all-green among those',green,'not green',len(notgreen))
for x in notgreen[:6]: print('  ',x)
print('### 6 levers')
for pr_ in ('268',):
    l=byPR[pr_];print('PR 268 heads',len(l),'select-all heads',sum(1 for x in l if sel.get(x,{}).get('select_all')),'runner-min',round(sum(R[x[:10]]['runner_min'] for x in l),1))
c=collections.Counter()
for v in sel.values():
    for p in v['paths']:
        if p['kind']=='class' and p['owner']=='policy': c[re.sub(r'^(\.github/[^/]+|\.circleci|\.github).*',r'\1',p['path'])]+=1
print('policy-class path hits by top dir',c.most_common())
c2=collections.Counter()
for s,v in sel.items():
    if v['select_all']: c2[v['pr']]+=1
print('select-all heads by PR',sorted(c2.items()))
# semantic-edge pos shards
n=0;rm=0.0;lst=[]
for s,v in sel.items():
    if 'pos/test' not in v['needed'] or v['select_all']: continue
    own=any(p['owner']=='pos' and p['jobs']!='ALL' and 'pos/test' in p['jobs'] for p in v['paths'] if p['kind']=='product')
    if own: continue
    n+=1;rm+=sum(j['dur_s'] for j in jb[s] if j['key'] in('pos/test-shard-1','pos/test-shard-2','pos/test-shard-3','pos/test','pos/static'))/60;lst.append((v['pr'],R[s[:10]]['idx']))
print('heads where pos/test(+shards,+pos/static) selected only via a non-POS semantic edge:',n,'runner-min of pos static+test jobs',round(rm,1),'PRs',sorted({a for a,b in lst}))
