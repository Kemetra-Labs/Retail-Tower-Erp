import json,glob,subprocess,os,re,sys
S=sys.argv[1]
rs={r['id']:r for r in json.load(open(S+'/runs.json'))}
for f in glob.glob(S+'/jobs/*.json'):
    rid=int(os.path.basename(f)[:-5]); r=rs[rid]
    if r['name']=='pos':
        j=[x for x in json.load(open(f)) if x['name']=='plan']
        if j:
            print(r['head_sha'],j[0]['id'])
            o=subprocess.run(['gh','api','repos/Kemetra-Labs/Retail-Tower-Erp/actions/jobs/%d/logs'%j[0]['id']],capture_output=True,text=True)
            for l in o.stdout.splitlines():
                if re.search(r'base=|BASE_SHA|PR_BASE|HEAD_SHA|selected',l): print(l[:250])
            break
