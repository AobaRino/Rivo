"""Run after run.py setup in a new owned sandbox directory."""
import hashlib
import json
import time
import safety
from run import wait

root=safety.ROOT
m=json.loads(safety.MANIFEST.read_text())
manager=m['manager']
docker,command,record=safety.docker,safety.command,safety.record
safety.results=json.loads(safety.RESULTS.read_text())

def req(path,method='GET',body=None,headers=None,proxy=None):
    q={'URL':path if path.startswith('http') else 'http://127.0.0.1:18787'+path,
       'Method':method,'Body':json.dumps(body) if body is not None else '', 'Headers':headers or {}}
    if proxy:q['Proxy']='http://127.0.0.1:'+str(proxy)
    return json.loads(docker('exec',manager,'/fixture','request',json.dumps(q),timeout=25))
def get(path):
    r=req(path);assert r['status']==200,r;return json.loads(r['body'])
def core():return get('/api/core')
def state():return get('/api/state')
def done():
    s=core();return s if not s['busy'] else None
def native(path):
    r=req('http://127.0.0.1:19090'+path,headers={'Authorization':'Bearer isolated-core-test-only-secret'})
    assert r['status']==200,r
    return json.loads(r['body'])
def post(action,body,code=202):
    r=req('/api/core/'+action,'POST',body);assert r['status']==code,r
def save(text):
    s=state();r=req('/api/draft','PUT',{'text':text},{'If-Match':s['revision']})
    assert r['status']==200,r
    return json.loads(r['body'])
def apply_request(s,code=202,**override):
    body={'revision':s['revision'],'expectedCurrent':s['core']['currentID'],'expectedApplied':s['appliedRevision']}
    body.update(override)
    r=req('/api/apply','POST',body);assert r['status']==code,r
def apply(text,success=True):
    before=state();s=save(text);apply_request(s);after=wait(done,80)
    assert (after['operation']['status']=='succeeded')==success,after
    s=state();assert s['draft']==text,s
    if success:
        assert s['applied']==text and s['appliedRevision']==hashlib.sha256(text.encode()).hexdigest(),s
        cfg=after['configuration'];assert (root/'data/core/configurations'/cfg['id']/'config.yaml').read_bytes()==text.encode()
        assert any(h['kind']=='core-apply' and h['text']==text for h in s['history'])
    else:
        assert s['applied']==before['applied'] and s['appliedRevision']==before['appliedRevision'],s
    return after
def traffic(port):
    r=req('http://source:8080/origin',proxy=port)
    assert r['status']==200 and r['body']=='sandbox-core-origin',r
def healthy(port,mode='rule'):
    c=core();assert c['running'] and not c['busy'],c
    cfg=native('/configs');assert cfg['mixed-port']==port and cfg['mode']==mode,cfg
    traffic(port)
def yaml(port=17890,mode='rule',extra=''):
    return f'# 保留原文及注释\nmixed-port: {port}\nmode: {mode}\nallow-lan: false\nipv6: false\nlog-level: warning\ndns: {{enable: false}}\ntun: {{enable: false}}\nrules:\n  - MATCH,DIRECT\nx-test-note: "untouched"\n'+extra

wait(core)
post('prepare',{'version':'v1.19.32','expectedCurrent':''});s=wait(done,90);assert s['operation']['status']=='succeeded',s
post('activate',{'id':s['prepared']['id'],'expectedCurrent':''});s=wait(done,50);assert s['operation']['status']=='succeeded',s
record('install real core for apply tests',{'core':s['current']['version'],'schema':s['current']['schemaVersion']})
initial=state()
s=apply(yaml(extra='proxies: [{name: bad, type: missing-protocol}]\n'),False)
assert s['configuration']['bootstrap'] and state()['appliedAt']==initial['appliedAt']
healthy(17890)
docker('restart','--time','5',manager);wait(lambda:core()['running'] and not core()['busy'],45)
assert state()['applied']==initial['applied'];healthy(17890)
record('failed first apply retains bootstrap configuration and cache home',True)
a=yaml();before=state()['applied'];save(a);assert state()['applied']==before;healthy(17890)
record('saving draft does not apply',True)
apply(a);healthy(17890)
record('apply exact YAML with comments and future fields',state()['appliedRevision'])
b=yaml(17891,'direct', '''proxies:
  - name: ManualDirect
    type: direct
proxy-providers:
  Subscription:
    type: http
    url: http://source:8080/subscription.yaml
    path: providers/subscription.yaml
    interval: 3600
    health-check: {enable: false}
proxy-groups:
  - name: Mixed
    type: select
    proxies: [ManualDirect]
    use: [Subscription]
''')
apply(b);healthy(17891,'direct')
wait(lambda: {'ManualDirect','SubscriptionDirect'} <= set(native('/proxies/Mixed')['all']))
record('applied native provider and manual proxy coexist',native('/proxies/Mixed')['all'])
record('changed mode and proxy port take effect',{'mode':native('/configs')['mode'],'port':native('/configs')['mixed-port']})
for name,text in [('invalid YAML','mode: [\n'),('native protocol rejection',b+'\nproxies: [{name: bad, type: missing-protocol}]\n')]:
    # Avoid a duplicate-key parse failure in the native-protocol case.
    if name=='native protocol rejection':text=yaml(17891,'direct','proxies: [{name: bad, type: missing-protocol}]\n')
    log=root/'data/core/releases'/core()['current']['id']/'runtime.log';stamp=log.stat().st_mtime_ns
    s=apply(text,False);assert log.stat().st_mtime_ns==stamp
    healthy(17891,'direct');record(name+' leaves old process running',s['operation']['error'])
for name,text in [('TUN rejected',yaml()+'tun: {enable: true}\n'),('controller conflict',yaml()+'external-controller: 0.0.0.0:9090\n'),('absolute provider cache',yaml()+'proxy-providers: {x: {type: http, path: /data/other.yaml}}\n')]:
    if name=='TUN rejected':text=yaml().replace('tun: {enable: false}','tun: {enable: true}')
    s=apply(text,False);healthy(17891,'direct');record(name,s['operation']['error'])
s=save(b);apply_request(s,409,revision='0'*64)
apply_request(s,expectedApplied='0'*64);s=wait(done);assert s['operation']['status']=='failed';healthy(17891,'direct')
record('stale draft and applied revisions rejected',True)
candidate=yaml(17892);s=save(candidate);apply_request(s)
apply_request(s,409)
post('prepare',{'version':'v1.19.33','expectedCurrent':s['core']['currentID']},409)
newer=candidate+'# saved while application is running\n';save(newer)
s=wait(done);assert s['operation']['status']=='succeeded',s
assert state()['applied']==candidate and state()['draft']==newer
healthy(17892);record('immutable submitted revision and concurrent task rejection',True)
docker('exec','-d',manager,'/fixture','hold-port')
time.sleep(.2)
s=apply(yaml(17899),False);assert '已恢复原配置' in s['operation']['error'];healthy(17892)
record('occupied proxy port restores previous configuration',s['operation']['error'])
old=state();schema=get('/api/core/schema')['id'];s=save(yaml(17893));apply_request(s)
wait(lambda: native('/configs')['mixed-port']==17893,30)
docker('exec',manager,'/fixture','kill-candidate',s['core']['currentID'])
s=wait(done);assert s['operation']['status']=='failed',s
assert state()['applied']==old['applied'] and get('/api/core/schema')['id']==schema
healthy(17892);record('candidate crash restores configuration without changing Schema',s['operation']['error'])
s=save(yaml(17894));apply_request(s)
wait(lambda: core()['operation']['phase']=='应用配置并检查运行状态',30)
docker('kill','--signal','KILL',manager);docker('start',manager)
wait(lambda: core()['running'] and not core()['busy'],45)
assert state()['applied']==old['applied'] and state()['draft']==yaml(17894)
healthy(17892);record('interrupted apply recovers committed config and retains draft',True)
# Version management uses the new committed config, never the bootstrap file.
s=core();post('prepare',{'version':'v1.19.33','expectedCurrent':s['current']['id']});s=wait(done,90)
assert s['operation']['status']=='succeeded',s
post('activate',{'id':s['prepared']['id'],'expectedCurrent':s['current']['id']});s=wait(done,45)
assert s['operation']['status']=='succeeded' and s['current']['version']=='v1.19.33',s
healthy(17892);assert state()['applied']==old['applied']
post('rollback',{'id':s['previous']['id'],'expectedCurrent':s['current']['id']});s=wait(done,45)
assert s['operation']['status']=='succeeded' and s['current']['version']=='v1.19.32',s
healthy(17892);record('core update and rollback preserve applied configuration',True)
apply(a);healthy(17890)
docker('restart','--time','5',manager);wait(lambda:core()['running'] and not core()['busy'],45)
assert state()['applied']==a;healthy(17890)
record('successful configuration persists across restart',state()['appliedRevision'])
assert req('/api/runtime','PATCH',{'mode':'direct'})['status']==409
record('managed runtime cannot silently modify simulator',True)
record('existing containers unchanged',safety.compare_baseline())
(root/'apply-final-state.json').write_text(json.dumps(state(),indent=2,ensure_ascii=False))
(root/'apply-manager.log').write_text(docker('logs',manager))
print('APPLY_TESTS_COMPLETE',flush=True)
