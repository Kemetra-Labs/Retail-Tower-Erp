import json,sys,collections,statistics as st,csv
S=sys.argv[1]
def ld(p):
    with open(p,encoding='utf-8') as f: return json.load(f)
sel=ld(S+'/selection.json');A=ld(S+'/analysis.json');rows=A['rows'];cf=A['cf'];D=ld(S+'/shas.json');jobs=ld(S+'/jobs.json')
full={s[:10]:s for s in D['shas']}
R={r['sha']:r for r in rows}
jb=collections.defaultdict(list)
for j in jobs: jb[j['sha']].append(j)
SKIPK=('boundary-check','dependency-review')
tot=sum(r['runner_min'] for r in rows)
# ---- select-all cost
sa=[(s,v) for s,v in sel.items() if v['select_all']]
def rm(s): return R[s[:10]]['runner_min']
by=collections.defaultdict(lambda:[0,0.0,set()])
for s,v in sa:
    k='+'.join(sorted(set(v['select_all_reasons'])))
    by[k][0]+=1;by[k][1]+=rm(s);by[k][2].add(v['pr'])
print('select-all shas',len(sa),'runner-min',round(sum(rm(s) for s,v in sa),1),'of total',round(tot,1),'=',round(100*sum(rm(s) for s,v in sa)/tot,1),'%')
for k,(n,r_,p) in by.items(): print('  ',k,n,'shas',len(p),'PRs','runner',round(r_,1))
print('select-all PRs:',sorted({v['pr'] for s,v in sa}))
# ---- what-if savings: jobs actually run not in whatif set (upper bound)
def saved(s,needed):
    n=set(needed);return sum(j['dur_s'] for j in jb[s] if j['key'] and j['key'] not in n and j['key'] not in SKIPK)/60
for cat in('changelog_d','docs_md','contracts_PIN','generated','ALL_incidental'):
    tot_s=0;nsha=0;prs=set();first=0
    for s,v in sel.items():
        sv=saved(s,v['whatif'][cat])
        if sv>0.01: tot_s+=sv;nsha+=1;prs.add(v['pr'])
    print('whatif drop',cat,'shas affected',nsha,'PRs',len(prs),'runner-min saved (upper bound)',round(tot_s,1),'=',round(100*tot_s/tot,1),'% of total')
# docs-only PRs
print('== BC high-tier docs/changelog-only shas')
BC=set(['bc/fast','bc/db-integration','bc/db-package','bc/oasdiff','bc/contracts-compat','bc/schemathesis'])
x=0;xs=[]
for s,v in sel.items():
    if BC<=set(v['needed']) and not BC<=set(v['whatif']['ALL_incidental']):
        bcm=sum(j['dur_s'] for j in jb[s] if j['key'] in BC)/60;x+=bcm;xs.append((v['pr'],R[s[:10]]['idx'],round(bcm,1)))
print('shas where incidental removal drops all of bc-full:',len(xs),'BC runner-min on those shas',round(x,1),xs)
# ---- counterfactual anchor
done=[c for c in cf if c.get('anchor')]
print('corrective pushes',len(cf),'with prior green anchor',len(done),'no anchor',len(cf)-len(done))
print('notes',collections.Counter(c.get('note') for c in cf if c.get('note')))
sv=sum(c['saved_runner_min'] for c in done);sv2=sum(c['saved_runner_min_excl_cancelled'] for c in done)
rmall=sum(c['runner_min'] for c in cf);rmdone=sum(c['runner_min'] for c in done)
print('anchored pushes runner-min',round(rmdone,1),'saved (incl cancelled work)',round(sv,1),'excl cancelled',round(sv2,1),'pct of anchored',round(100*sv/rmdone,1),'pct of all corrective',round(100*sv/rmall,1),'pct of total',round(100*sv/tot,1))
w=[c for c in done if 'wall_saved_min' in c]
print('wall-estimable',len(w),'median actual wall',st.median(c['wall_min'] for c in w),'median cf wall',st.median(c['wall_cf_min'] for c in w),'sum saved',round(sum(c['wall_saved_min'] for c in w),1),'median saved',st.median(c['wall_saved_min'] for c in w))
print('anchor_dist',collections.Counter(c['anchor_dist'] for c in done))
print('cf sel_all (anchor diff) vs actual sel_all', collections.Counter((c['actual_sel_all'],c['cf_sel_all']) for c in done))
print('n jobs actual vs cf: mean',round(st.mean(c['n_actual'] for c in done),1),round(st.mean(c['n_cf'] for c in done),1))
print('cf selecting only always jobs (<=3):',sum(1 for c in done if c['n_cf']<=3))
print('main-sync anchored',sum(1 for c in done if c['main_sync']),' saved among those',round(sum(c['saved_runner_min'] for c in done if c['main_sync']),1))
# by class
for flag,name in((lambda c:c['main_sync'],'main-sync'),(lambda c:(not c['main_sync']),'non-sync')):
    g=[c for c in done if flag(c)];print(name,len(g),'runner',round(sum(c['runner_min'] for c in g),1),'saved',round(sum(c['saved_runner_min'] for c in g),1))
# save per job
jc=collections.Counter()
for c in done:
    s=full[c['sha']]
    for j in jb[s]:
        if j['key'] and j['key'] not in c['cf_jobs'] and j['key'] not in SKIPK: jc[j['key']]+=j['dur_s']/60
print('saved by job',[(k,round(v,1)) for k,v in jc.most_common()])
# conservative: only count pushes whose anchor was the immediately preceding head (dist 1)
d1=[c for c in done if c['anchor_dist']==1]
print('anchor_dist==1:',len(d1),'saved',round(sum(c['saved_runner_min'] for c in d1),1),'of',round(sum(c['runner_min'] for c in d1),1))
# caveat: sha with actual cancelled (superseded) hmm
sup=[c for c in done if c['required'] in('none',None)]
print('anchored pushes that were themselves superseded (never gated):',len(sup),'saved',round(sum(c['saved_runner_min'] for c in sup),1))
gated=[c for c in done if c['required'] not in('none',None)]
print('anchored pushes that completed required:',len(gated),'saved',round(sum(c['saved_runner_min'] for c in gated),1),'runner',round(sum(c['runner_min'] for c in gated),1))
print('details: pr idx anchor dist n_actual n_cf saved wall wall_cf')
for c in done[:70]: print(c['pr'],c['idx'],c['anchor'],c['anchor_dist'],c['n_actual'],c['n_cf'],c['saved_runner_min'],c['wall_min'],c.get('wall_cf_min'),'sync' if c['main_sync'] else '')
