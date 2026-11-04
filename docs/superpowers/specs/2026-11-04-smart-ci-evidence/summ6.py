import json,sys,collections,statistics as st,csv,re
S=sys.argv[1]
def ld(p):
    with open(p,encoding='utf-8') as f: return json.load(f)
sel=ld(S+'/selection.json');A=ld(S+'/analysis.json');rows=A['rows'];D=ld(S+'/shas.json')
N=len(sel);PRS=len({v['pr'] for v in sel.values()})
BC=set(['bc/fast','bc/db-integration','bc/db-package','bc/oasdiff','bc/contracts-compat','bc/schemathesis'])
POSF={'pos/static','pos/test-shard-1','pos/test-shard-2','pos/test-shard-3','pos/test'}
print('shas evaluated',N,'PRs',PRS)
def has(v,S_): return S_<=set(v['needed'])
print('select_all shas',sum(v['select_all'] for v in sel.values()),collections.Counter(r for v in sel.values() for r in v['select_all_reasons']))
print('bc-full(all 6)',sum(has(v,BC) for v in sel.values()),'  bc/db-integration',sum('bc/db-integration' in v['needed'] for v in sel.values()),'  bc/schemathesis',sum('bc/schemathesis' in v['needed'] for v in sel.values()),' bc/fast but not full',sum(('bc/fast' in v['needed']) and not has(v,BC) for v in sel.values()))
print('pos-full',sum(has(v,POSF) for v in sel.values()),' pos/package-windows',sum('pos/package-windows' in v['needed'] for v in sel.values()),' pos/e2e-electron',sum('pos/e2e-electron' in v['needed'] for v in sel.values()),' admin/e2e',sum('admin/e2e' in v['needed'] for v in sel.values()),' connector/bench',sum('connector/bench' in v['needed'] for v in sel.values()),' e2e/smoke',sum('e2e/smoke' in v['needed'] for v in sel.values()))
print('distribution of #selected jobs',sorted(collections.Counter(len(v['needed']) for v in sel.values()).items()))
print('only always-jobs (+pos/docs)',sum(set(v['needed'])<= {'boundary-check','dependency-review','pos/docs'} for v in sel.values()))
def drivers(job):
    c=collections.Counter();ex={}
    for v in sel.values():
        if job not in v['needed']: continue
        causes=set()
        for p in v['paths']:
            j=p['jobs']
            if j=='ALL' or job in j:
                if p['kind']=='class': key='class:'+p['owner']+('(select-all)' if j=='ALL' else '')
                elif p['kind']=='unknown': key='unknown'
                else: key=p['owner']+':'+'+'.join(p['tiers'])
                causes.add(key);ex.setdefault(key,p['path'])
        for k in causes: c[k]+=1
        if not causes: c['(edge/other)']+=1
    return c,ex
for job in('bc/db-integration','bc/schemathesis','pos/package-windows','admin/e2e','pos/test','connector/bench'):
    c,ex=drivers(job);print('DRIVERS of',job,'(shas selecting it:',sum(job in v['needed'] for v in sel.values()),')')
    for k,n in c.most_common(12): print('   ',k,n,ex.get(k,''))
print('== incidental categories')
catsha=collections.Counter();catpr=collections.defaultdict(set);marg=collections.Counter();margpr=collections.defaultdict(set)
for s,v in sel.items():
    present={c for p in v['paths'] for c in p['cats']}
    for c in present: catsha[c]+=1;catpr[c].add(v['pr'])
    for c,nj in v['whatif'].items():
        if c=='ALL_incidental': continue
        if set(nj)!=set(v['needed']): marg[c]+=1;margpr[c].add(v['pr'])
for c in catsha: print(c,'present in shas',catsha[c],'PRs',len(catpr[c]),'| dropping it alone changes selection in shas',marg[c],'PRs',len(margpr[c]))
allch=[(s,v) for s,v in sel.items() if set(v['whatif']['ALL_incidental'])!=set(v['needed'])]
print('dropping ALL incidental changes selection in',len(allch),'of',N,'shas; PRs',len({v['pr'] for s,v in allch}))
rem=collections.Counter()
for s,v in allch:
    for j in set(v['needed'])-set(v['whatif']['ALL_incidental']): rem[j]+=1
print('jobs removed (count of shas):',rem.most_common())
only=[(s,v) for s,v in sel.items() if set(v['whatif']['ALL_incidental'])<={'boundary-check','dependency-review'} and any(p['cats'] for p in v['paths'])]
print('shas whose selection collapses to always-only once incidental removed:',len(only))
bchigh=0;bcdocs=0
for s,v in sel.items():
    bp=[p for p in v['paths'] if p['owner']=='backend-core']
    if bp and BC<=set(v['needed']) and not v['select_all'] and all(p['tiers']==['high'] for p in bp if p['kind']=='product'):
        bchigh+=1
        if all(('changelog_d' in p['cats'] or 'docs_md' in p['cats']) for p in bp): bcdocs+=1
print('shas where bc-full selected solely via untiered BC high paths:',bchigh,' of which only changelog.d/docs/md:',bcdocs)
cl=[(s,v) for s,v in sel.items() if any('changelog_d' in p['cats'] for p in v['paths'])]
print('changelog.d shas',len(cl),'PRs',len({v['pr'] for s,v in cl}),'-> selection includes bc-full:',sum(BC<=set(v['needed']) for s,v in cl),'; bc-full NOT selected without it:',sum((BC<=set(v['needed'])) and not (BC<=set(v['whatif']['changelog_d'])) for s,v in cl))
pc=[(s,v) for s,v in sel.items() if v['policy_change']];print('policy_change shas',len(pc),'PRs',len({v['pr'] for s,v in pc}))
for cl_ in('policy','tooling','root','system','docs','e2e','rootdocs'):
    n=[(s,v) for s,v in sel.items() if any(p['kind']=='class' and p['owner']==cl_ for p in v['paths'])]
    print('class',cl_,'present shas',len(n),'PRs',len({v['pr'] for s,v in n}),'selects-all shas',sum(v['select_all'] for s,v in n if cl_ in('policy','tooling','root','system')))
c=collections.Counter()
for v in sel.values():
    for p in v['paths']:
        if p['jobs']=='ALL': c[(p['kind'],p['owner'],p['path'].rsplit('/',1)[0][:60])]+=1
print('ALL-select path dirs:',c.most_common(12))
c=collections.Counter()
for v in sel.values():
    if BC<=set(v['needed']):
        for p in v['paths']:
            if p['jobs']=='ALL' or BC<=set(p['jobs']): c['/'.join(p['path'].split('/')[:4])]+=1
print('dirs behind bc-full',c.most_common(15))
