import json,sys,collections,statistics as st,datetime as dt,csv
S=sys.argv[1]
def ld(p):
    with open(p,encoding='utf-8') as f: return json.load(f)
T=lambda s:dt.datetime.strptime(s,'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=dt.timezone.utc) if s else None
A=ld(S+'/analysis.json');rows=A['rows'];D=ld(S+'/shas.json')
fullof={s[:10]:s for s in D['shas']}
cor=[r for r in rows if r['kind']=='corrective']
def cls(r):
    a=r['after_bot_review'];m=r['main_sync']
    if a and m: return 'bot-review + main-merge'
    if a: return 'after bot review (code push)'
    if m: return 'main-merge only (no bot review before)'
    if r['after_owner_review']: return 'after owner review only'
    return 'other (self-initiated fix/push)'
agg=collections.OrderedDict()
for r in cor:
    c=cls(r);d=agg.setdefault(c,dict(n=0,rm=0.0,canc=0.0,wall=[],none=0));d['n']+=1;d['rm']+=r['runner_min'];d['canc']+=r['rm_cancelled'];d['none']+=(r['state']=='none')
    if r['wall_min'] is not None: d['wall'].append(r['wall_min'])
print('corrective n',len(cor))
for c,d in agg.items(): print(c,d['n'],'runner',round(d['rm'],1),'cancelled',round(d['canc'],1),'superseded/none',d['none'],'wall_sum',round(sum(d['wall']),1),'n_wall',len(d['wall']))
print('flags: main_sync',sum(r['main_sync'] for r in cor),'after_bot_review',sum(r['after_bot_review'] for r in cor),'after_bot_any',sum(r['after_bot_any'] for r in cor),'after_owner_review',sum(r['after_owner_review'] for r in cor))
print('bot-review-precedes-push lag median min',st.median([r['lag_bot_review_to_push_min'] for r in cor if r['lag_bot_review_to_push_min'] is not None]))
print('gap from previous push median min',st.median([r['gap_prev_push_min'] for r in cor]), 'p25', sorted(r['gap_prev_push_min'] for r in cor)[len(cor)//4])
# cancelled by previous push before it finished: how many corrective pushes arrived while previous sha still running (prev state none)
prevnone=0
for r in cor:
    prev=[x for x in rows if x['pr']==r['pr'] and x['idx']==r['idx']-1][0]
    # Not yet gated when this push landed: no required yet, or it completed only after the push.
    if not prev['required_at'] or T(prev['required_at'])>T(r['push']): prevnone+=1
print('corrective pushes that superseded a not-yet-gated head',prevnone)
# bot review timing vs first push
ev=collections.defaultdict(list)
for n in {r['pr'] for r in rows}:
    for x in ld(f'{S}/pr_reviews/{n}.json'):
        if x['type']=='Bot' and x['submitted_at']: ev[n].append(T(x['submitted_at']))
    for x in ld(f'{S}/pr_comments/{n}.json'):
        if x['type']=='Bot': ev[n].append(T(x['created_at']))
lags=[];beforereq=0;n=0
for r in rows:
    pushT=T(r['push']);nxt=[r2 for r2 in rows if r2['pr']==r['pr'] and r2['idx']==r['idx']+1]
    lim=T(nxt[0]['push']) if nxt else None
    e=[t for t in ev[r['pr']] if t>=pushT and (lim is None or t<lim)]
    if e:
        lags.append((min(e)-pushT).total_seconds()/60)
        if r['required_at'] and min(e)<T(r['required_at']): beforereq+=1
        n+=1
print('shas receiving a bot review before the next push',n,'median lag push->first bot review',round(st.median(lags),1),'p90',round(sorted(lags)[int(.9*(len(lags)-1))],1),'arrived before required completed',beforereq)
# PRs: number with any bot review
print('PRs with >=1 corrective:',len({r['pr'] for r in cor}),'of',len({r['pr'] for r in rows}))
# per-PR: share of corrective pushes after bot review
