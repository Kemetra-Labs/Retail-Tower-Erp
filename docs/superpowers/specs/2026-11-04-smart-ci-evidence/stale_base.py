import json,sys,subprocess,collections,statistics as st
S=sys.argv[1];sys.path.insert(0,S)
import sel_lib as L
def ld(p):
    with open(p,encoding='utf-8') as f: return json.load(f)
D=ld(S+'/shas.json');shas=D['shas'];jobs=ld(S+'/jobs.json');A=ld(S+'/analysis.json')['rows'];R={r['sha']:r for r in A}
jb=collections.defaultdict(list)
for j in jobs: jb[j['sha']].append(j)
SKIPK=('boundary-check','dependency-review')
n=0;behind=0;diffsel=0;saved=0.0;rows=[];behindcount=[]
for s,d in shas.items():
    b=d['base']
    if not b: continue
    mb=subprocess.run(['git','-C',L.WT,'merge-base',b,s],capture_output=True,text=True).stdout.strip()
    n+=1
    nb=int(subprocess.run(['git','-C',L.WT,'rev-list','--count',f'{mb}..{b}'],capture_output=True,text=True).stdout.strip() or 0)
    if mb!=b:
        behind+=1
        p1,_=L.evaluate(b,s);p2,_=L.evaluate(b,s,change_base=mb)
        a,c=set(p1['needed_jobs']),set(p2['needed_jobs'])
        extra=a-c
        sv=sum(j['dur_s'] for j in jb[s] if j['key'] in extra and j['key'] not in SKIPK)/60 if extra else 0
        if extra: diffsel+=1;saved+=sv
        rows.append(dict(sha=s[:10],pr=d['pr'],commits_behind=nb,extra_jobs=sorted(extra),saved=round(sv,1),state=R[s[:10]]['state']))
        behindcount.append(nb)
    else: behindcount.append(0)
print('shas',n,'head behind PR base (merge-base != base):',behind,'| selection differs when diffing from merge-base:',diffsel,'| runner-min on jobs selected only because of stale base:',round(saved,1))
print('commits behind (all shas): median',st.median(behindcount),'mean',round(st.mean(behindcount),1),'max',max(behindcount))
for r in sorted(rows,key=lambda r:-r['saved'])[:12]: print(r)
json.dump(rows,open(S+'/stale_base.json','w'))
