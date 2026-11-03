"""Additional readiness regressions after apply_test.py and run.py tests.

Only uses the dedicated sandbox manifest and controlled subscription fixture.
"""
import hashlib
import json
from pathlib import Path
import safety
from run import wait

root = safety.ROOT
m = json.loads(safety.MANIFEST.read_text())
manager = m['manager']
docker, command, record = safety.docker, safety.command, safety.record
safety.results = json.loads(safety.RESULTS.read_text())


def req(path, method='GET', body=None, headers=None):
    q = {'URL': 'http://127.0.0.1:18787' + path, 'Method': method,
         'Body': json.dumps(body) if body is not None else '', 'Headers': headers or {}}
    return json.loads(docker('exec', manager, '/fixture', 'request', json.dumps(q)))


def get(path):
    r = req(path)
    assert r['status'] == 200, r
    return json.loads(r['body'])


def core(): return get('/api/core')
def state(): return get('/api/state')


def done():
    s = core()
    return s if not s['busy'] else None


def post(action, body):
    r = req('/api/core/' + action, 'POST', body)
    assert r['status'] == 202, r


def save(text):
    s = state()
    r = req('/api/draft', 'PUT', {'text': text}, {'If-Match': s['revision']})
    assert r['status'] == 200, r
    return json.loads(r['body'])


def apply(text):
    s = save(text)
    r = req('/api/apply', 'POST', {'revision': s['revision'],
            'expectedCurrent': s['core']['currentID'], 'expectedApplied': s['appliedRevision']})
    assert r['status'] == 202, r
    s = wait(done, 60)
    assert s['operation']['status'] == 'succeeded', s


s = state()
status = req('/api/status')
compact = json.loads(status['body'])
assert status['status'] == 200 and compact['revision'] == s['revision']
assert not {'draft', 'applied', 'history'} & compact.keys()
assert len(status['body']) < 4096
record('compact polling excludes configuration and history', {'bytes': len(status['body'])})
saved = save(s['draft'] + '# other page saved\n')
stale = req('/api/draft', 'PUT', {'text': s['draft'] + '# stale page\n'}, {'If-Match': s['revision']})
assert stale['status'] == 409 and state()['draft'] == saved['draft']
save(s['draft'])
record('stale page cannot overwrite a newer saved draft', True)

probe = command('docker', 'exec', '-w', '/data/work', manager, '/manager', check=False)
assert probe.returncode != 0 and '目录已由另一个管理服务使用' in probe.stderr, probe.stderr
assert core()['running']
record('second manager refused without stopping active core', True)

# Mutate only the newly staged candidate home, then crash the candidate core.
# The confirmed home's marker must remain byte-for-byte intact after recovery.
old = core()
config_root = root / 'data/core/configurations'
old_home = config_root / old['configuration']['id'] / 'home'
marker = old_home / 'review-resource.txt'
marker.write_text('confirmed resource')
before_dirs = set(config_root.iterdir())
post('prepare', {'version': 'v1.19.31', 'expectedCurrent': old['current']['id']})
s = wait(done, 90)
assert s['operation']['status'] == 'succeeded', s
target = s['prepared']
post('activate', {'id': target['id'], 'expectedCurrent': old['current']['id']})
wait(lambda: '切换进程' in core()['operation']['phase'], 25)
new_dirs = set(config_root.iterdir()) - before_dirs
assert len(new_dirs) == 1, new_dirs
candidate = new_dirs.pop()
candidate_marker = candidate / 'home/review-resource.txt'
assert candidate_marker.read_text() == 'confirmed resource'
candidate_marker.write_text('candidate changed resource')
wait(lambda: command('docker', 'exec', manager, '/fixture', 'kill-candidate', target['id'], check=False).returncode == 0, 10)
s = wait(done)
assert s['operation']['status'] == 'failed' and s['running'], s
assert s['current']['id'] == old['current']['id'] and s['configuration'] == old['configuration']
assert marker.read_text() == 'confirmed resource' and not candidate.exists()
marker.unlink()
record('failed core upgrade keeps confirmed resources and prunes candidate', True)

base = state()['applied']
providers = '''
proxy-providers:
  ReviewLoaded:
    type: http
    url: http://source:8080/subscription.yaml
    proxy: DIRECT
    path: providers/review-loaded.yaml
    health-check: {enable: false}
  ReviewEmpty:
    type: http
    url: http://source:8080/missing-review.yaml
    proxy: DIRECT
    path: providers/review-empty.yaml
    health-check: {enable: false}
proxy-groups:
  - name: ReviewGroup
    type: select
    proxies: [DIRECT]
    use: [ReviewLoaded, ReviewEmpty]
'''
apply(base + providers)


def loaded():
    r = get('/api/core/providers')
    rows = {p['name']: p for p in r['providers']}
    return r if rows.get('ReviewLoaded', {}).get('state') == 'loaded' else None

r = wait(loaded, 30)
rows = {p['name']: p for p in r['providers']}
assert rows['ReviewLoaded']['nodes'] == 1 and rows['ReviewLoaded'].get('updatedAt')
assert rows['ReviewEmpty']['nodes'] == 0 and rows['ReviewEmpty']['state'] in ('empty', 'missing')
assert r['appliedRevision'] == state()['appliedRevision']
assert 'http://' not in json.dumps(r) and 'SubscriptionDirect' not in json.dumps(r)
record('native provider status distinguishes loaded and empty subscriptions', rows)
record('provider status omits URLs and node details', True)
# Keep this controlled configuration for the subsequent two-tab browser checks.
(root / 'review-ui-baseline.yaml').write_text(base)
(root / 'review-final-state.json').write_text(json.dumps(core(), indent=2))
record('existing containers unchanged after readiness tests', safety.compare_baseline())
print('REVIEW_TESTS_COMPLETE', flush=True)
