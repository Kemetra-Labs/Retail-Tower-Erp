import json,sys,collections,datetime as dt
S=sys.argv[1]
def ld(p):
    with open(p,encoding='utf-8') as f: return json.load(f)
A=ld(S+'/analysis.json');rows=A['rows'];jobs=ld(S+'/jobs.json');prs={p['number']:p for p in ld(S+'/prs40.json')};D=ld(S+'/shas.json')
full={s[:10]:s for s in D['shas']}
jb=collections.defaultdict(list)
for j in jobs: jb[j['sha']].append(j)
term={}
for r in rows:
    if r['pr'] not in term or r['idx']>term[r['pr']]['idx']: term[r['pr']]=r
for n,r in sorted(term.items()):
    if r['state']!='none': continue
    s=full[r['sha']];js=jb[s]
    c=collections.Counter(j['conclusion'] for j in js if j['workflow']!='gate')
    g=[(j['job'],j['conclusion'],j['completed']) for j in js if j['workflow']=='gate']
    print(n,'merged',prs[n]['mergedAt'],'push',r['push'],'required',r['required'],r['required_at'],dict(c),g)
