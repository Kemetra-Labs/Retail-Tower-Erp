import json,subprocess,os,sys
from concurrent.futures import ThreadPoolExecutor
S=sys.argv[1];R='repos/Kemetra-Labs/Retail-Tower-Erp'
prs=json.load(open(S+'/prs40.json'))
def api(path,jq):
    o=subprocess.run(['gh','api','--paginate',path,'--jq',jq],capture_output=True)
    if o.returncode!=0: raise RuntimeError(f'gh api {path} failed: {o.stderr[:150]!r}')
    return '['+','.join(l for l in o.stdout.decode('utf-8','replace').splitlines() if l.strip())+']'
JQ={'pr_reviews':('reviews','.[]|{user:.user.login,type:.user.type,state,submitted_at,commit_id,body:((.body // "")[0:200])}'),
 'pr_comments':('pulls/%d/comments','.[]|{user:.user.login,type:.user.type,created_at,commit_id,path,body:((.body // "")[0:120])}'),
 'issue_comments':('issues/%d/comments','.[]|{user:.user.login,type:.user.type,created_at,body:((.body // "")[0:120])}'),
 'pr_commits':('pulls/%d/commits','.[]|{sha,date:.commit.committer.date,msg:((.commit.message // "")[0:80])}')}
def pr(n):
    for d,(path,jq) in (('pr_reviews',('pulls/%d/reviews',JQ['pr_reviews'][1])),('pr_comments',JQ['pr_comments']),('issue_comments',JQ['issue_comments']),('pr_commits',JQ['pr_commits'])):
        p=f'{S}/{d}/{n}.json'
        if os.path.exists(p):continue
        v=api(f'{R}/'+(path%n),jq)
        open(p,'w',encoding='utf-8').write(v)
with ThreadPoolExecutor(6) as ex: list(ex.map(pr,[p['number'] for p in prs]))
print('done')
