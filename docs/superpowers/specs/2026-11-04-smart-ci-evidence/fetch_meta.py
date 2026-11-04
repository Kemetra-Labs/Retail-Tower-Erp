import json,subprocess,os,sys
from concurrent.futures import ThreadPoolExecutor
S=sys.argv[1]
R='repos/Kemetra-Labs/Retail-Tower-Erp'
prs=json.load(open(S+'/prs40.json'));heads={p['headRefName']:p['number'] for p in prs}
rs=json.load(open(S+'/runs.json'))
m=[r for r in rs if r['head_branch'] in heads and r['event'] in('pull_request','pull_request_target')]
shas=sorted({(r['head_sha'],heads[r['head_branch']]) for r in m})
for d in('cr','pr_reviews','pr_comments','issue_comments','pr_commits'):os.makedirs(f'{S}/{d}',exist_ok=True)
def api(path,jq):
    o=subprocess.run(['gh','api','--paginate',path,'--jq',jq],capture_output=True,text=True)
    if o.returncode!=0: return None
    return '['+','.join(l for l in o.stdout.splitlines() if l.strip())+']'
def cr(x):
    sha,n=x;p=f'{S}/cr/{sha}.json'
    if os.path.exists(p):return
    v=api(f'{R}/commits/{sha}/check-runs?per_page=100','.check_runs[]|{name,status,conclusion,started_at,completed_at,app:.app.slug}')
    if v: open(p,'w').write(v)
def pr(n):
    for d,path,jq in (('pr_reviews',f'{R}/pulls/{n}/reviews','{user:.user.login,type:.user.type,state,submitted_at,commit_id,body:(.body[0:200])}'),
                      ('pr_comments',f'{R}/pulls/{n}/comments','{user:.user.login,type:.user.type,created_at,commit_id,path,body:(.body[0:120])}'),
                      ('issue_comments',f'{R}/issues/{n}/comments','{user:.user.login,type:.user.type,created_at,body:(.body[0:120])}'),
                      ('pr_commits',f'{R}/pulls/{n}/commits','{sha,date:.commit.committer.date,msg:(.commit.message[0:80])}')):
        p=f'{S}/{d}/{n}.json'
        if os.path.exists(p):continue
        v=api(path,jq)
        if v: open(p,'w').write(v)
with ThreadPoolExecutor(6) as ex:
    list(ex.map(cr,shas)); list(ex.map(pr,[p['number'] for p in prs]))
print('done',len(shas))
