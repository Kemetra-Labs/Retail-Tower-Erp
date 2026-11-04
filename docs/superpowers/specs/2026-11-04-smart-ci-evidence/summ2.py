import json,sys,collections,statistics as st,csv
S=sys.argv[1]
def ld(p):
    with open(p,encoding='utf-8') as f: return json.load(f)
A=ld(S+'/analysis.json');rows=A['rows'];cf=A['cf'];jobs=ld(S+'/jobs.json');D=ld(S+'/shas.json');prs={p['number']:p for p in ld(S+'/prs40.json')}
R={r['sha']:r for r in rows}
# ---------- PR table
print('PR | n_sha | corr | runner_min | cancelled_min | red | none | first_push->merge_min | terminal_state | bot_rev_events')
pr_rows=[]
for n,p in sorted(prs.items()):
    rr=[r for r in rows if r['pr']==n]
    if not rr: continue
    first=min(r['push'] for r in rr)
    import datetime as dt
    T=lambda s:dt.datetime.strptime(s,'%Y-%m-%dT%H:%M:%SZ')
    life=(T(p['mergedAt'])-T(first)).total_seconds()/60
    term=max(rr,key=lambda r:r['idx'])
    d=dict(pr=n,n_shas=len(rr),n_corrective=len(rr)-1,runner_min=round(sum(r['runner_min'] for r in rr),1),cancelled_min=round(sum(r['rm_cancelled'] for r in rr),1),
        n_red=sum(1 for r in rr if r['state']=='red'),n_none=sum(1 for r in rr if r['state']=='none'),open_to_merge_min=round(life,1),terminal_state=term['state'],terminal_required=term['required'],
        files=p['changedFiles'],title=p['title'][:60],merged=p['mergedAt'],n_main_sync=sum(1 for r in rr if r['main_sync']),n_after_bot=sum(1 for r in rr if r['after_bot_review']))
    pr_rows.append(d);print(d)
with open(S+'/prs.csv','w',newline='',encoding='utf-8') as f:
    w=csv.DictWriter(f,fieldnames=list(pr_rows[0]));w.writeheader();w.writerows(pr_rows)
print('terminal states',collections.Counter(d['terminal_state'] for d in pr_rows))
print('shas/PR distribution',collections.Counter(d['n_shas'] for d in pr_rows))
print('sum runner',sum(d['runner_min'] for d in pr_rows),'mean/PR',st.mean(d['runner_min'] for d in pr_rows),'median',st.median(d['runner_min'] for d in pr_rows))
print('PR lifetime median min',st.median(d['open_to_merge_min'] for d in pr_rows))
