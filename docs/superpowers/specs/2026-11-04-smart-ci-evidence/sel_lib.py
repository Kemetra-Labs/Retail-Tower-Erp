import sys,functools,re,fnmatch
import os,pathlib
# Repo root: RT_WORKTREE overrides; default is this file's checkout (docs/superpowers/specs/<evidence>/ -> 4 up).
WT=os.environ.get('RT_WORKTREE') or str(pathlib.Path(__file__).resolve().parents[4])
sys.path.insert(0,WT+'/tools/project-graph')
from pgraph import evaluate as ev, gitio
from pgraph.graph import Graph, load_graph
GRAPH_PATH='tools/project-graph/graph.yaml'

@functools.lru_cache(None)
def base_ctx(base):
    wf=gitio.workflow_definitions(WT,base)
    return dict(trusted=gitio.read_text(WT,base,GRAPH_PATH) or '', tree=frozenset(gitio.list_tree(WT,base)), wf=wf, wj=gitio.workflow_jobs(WT,base,wf))
@functools.lru_cache(None)
def head_ctx(head):
    return dict(graph=gitio.read_text(WT,head,GRAPH_PATH), tree=frozenset(gitio.list_tree(WT,head)))
@functools.lru_cache(None)
def diff(a,b):
    return tuple(gitio.read_changes(WT,a,b))

def evaluate(base, head, change_base=None, drop=None, event='pull_request'):
    """trusted graph/trees from `base` (the real PR base); diff from change_base (default base) to head.
    drop: predicate on path -> True removes the change from the diff (what-if)."""
    b=base_ctx(base); h=head_ctx(head)
    changes=diff(change_base or base, head)
    if drop: changes=tuple(c for c in changes if not drop(c.path))
    proposed=None if h['graph']==b['trusted'] else (h['graph'] or '')
    inp=ev.EvalInput(event=event,base_sha=base,head_sha=head,changes=changes,trusted_text=b['trusted'],proposed_text=proposed,
        diff_error=False,workflow_jobs=b['wj'],workflows=b['wf'],base_tree=b['tree'],head_tree=h['tree'])
    return ev.evaluate(inp), changes

@functools.lru_cache(None)
def graph_of(base):
    return Graph(load_graph(base_ctx(base)['trusted']))

# incidental categories (what-if drops)
CATS={
 'changelog_d': lambda p: p.startswith('services/backend-core/changelog.d/'),
 'docs_md': lambda p: p.startswith('docs/') or '/docs/' in p or p.endswith('.md'),
 'contracts_PIN': lambda p: bool(re.match(r'apps/[^/]+/contracts/backend-core/PIN$',p)),
 'lockfile': lambda p: p.rsplit('/',1)[-1] in ('package-lock.json','pnpm-lock.yaml','pylock.toml'),
 'generated': lambda p: p=='apps/pos/src/shared/api-types.ts' or p.startswith('apps/admin-console/src/generated/'),
}
def any_cat(p): return any(f(p) for f in CATS.values())
def cat_of(p):
    return [k for k,f in CATS.items() if f(p)]
