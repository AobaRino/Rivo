"""Owned-container integration checks, with unchanged official release artifacts.

Upload beside safety.py (scripts/sandbox/run.py), binaries and fixtures into a
NEW ~/mm-sandbox-* directory. Commands: setup, tests, cleanup.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import safety

ROOT = Path(__file__).resolve().parent
assert ROOT.parent == Path.home() and ROOT.name.startswith('mm-sandbox-')
NAME = ROOT.name
LABEL = safety.LABEL
docker, command, record = safety.docker, safety.command, safety.record
MANIFEST = ROOT / 'manifest.json'

def wait(fn, seconds=45):
    end = time.monotonic() + seconds
    last = None
    while time.monotonic() < end:
        try:
            last = fn()
            if last: return last
        except Exception as e: last = str(e)
        time.sleep(.15)
    raise AssertionError(last)

def setup():
    assert (ROOT/'baseline.json').exists() and not MANIFEST.exists()
    assert command('docker','image','inspect',NAME+':test',check=False).returncode != 0
    m = {'name':NAME,'containers':[]}
    def save(): MANIFEST.write_text(json.dumps(m,indent=2))
    save()
    (ROOT/'data').mkdir(mode=0o700)
    for name in ['manager','fixture','manager-tests']: (ROOT/name).chmod(0o755)
    (ROOT/'Dockerfile').write_text('FROM scratch\nCOPY manager /manager\nCOPY fixture /fixture\nCOPY manager-tests /manager-tests\nUSER 1000:1000\nENTRYPOINT ["/fixture"]\n')
    (ROOT/'.dockerignore').write_text('*\n!Dockerfile\n!manager\n!fixture\n!manager-tests\n')
    result = command('docker','build','--network','none','--label',f'{LABEL}={NAME}','-t',NAME+':test','.',timeout=120)
    (ROOT/'build.log').write_text(result.stdout+result.stderr)
    m['image']=docker('image','inspect','--format','{{.Id}}',NAME+':test'); save()
    m['network']=docker('network','create','--internal','--label',f'{LABEL}={NAME}',NAME); save()
    def create(role, args, memory, network=True, extra=None):
        options = ['create','--name',NAME+'-'+role,'--label',f'{LABEL}={NAME}',
            '--network',m['network'] if network else 'none','--read-only','--cap-drop','ALL',
            '--security-opt','no-new-privileges=true','--user',f'{os.getuid()}:{os.getgid()}',
            '--memory',memory,'--memory-swap',memory,'--cpus','0.5','--pids-limit','128',
            '--restart','no','--log-driver','json-file','--log-opt','compress=false','--log-opt','max-size=2m','--log-opt','max-file=1',
            '--tmpfs',f'/tmp:rw,noexec,nosuid,size=64m,uid={os.getuid()},gid={os.getgid()}',
            '--mount',f'type=bind,src={ROOT / "fixtures"},dst=/fixtures,readonly']
        if extra: options += extra
        cid = docker(*options,m['image'],*args)
        m['containers'].append(cid); m[role]=cid; save()
        return cid
    unit=create('unit',[], '256m',False,['--entrypoint','/manager-tests'])
    docker('start',unit)
    exitcode=docker('wait',unit,timeout=60)
    logs=docker('logs',unit); (ROOT/'go-tests.log').write_text(logs)
    assert exitcode=='0',logs
    record('Linux Go tests',logs)
    source=create('source',['serve'],'128m',extra=[
        '--network-alias','source','--network-alias','api.github.com',
        '--network-alias','github.com','--network-alias','registry.npmjs.org'])
    docker('start',source)
    manager=create('manager',['boot'],'768m',extra=[
        '--env','MIHOMO_CORE_ENABLED=1','--env','MIHOMO_CORE_DIR=/data/core',
        '--env','MIHOMO_CORE_CONFIG=/data/coreconfig.yaml','--env','SSL_CERT_FILE=/fixtures/ca.crt',
        '--env','GOMEMLIMIT=256MiB','--mount',f'type=bind,src={ROOT / "data"},dst=/data'])
    docker('start',manager)
    info=json.loads(docker('inspect',manager,source))
    for c in info:
        assert c['HostConfig']['Privileged'] is False
        assert not c['HostConfig']['PortBindings'] and c['HostConfig']['CapDrop']==['ALL']
        assert c['HostConfig']['ReadonlyRootfs'] and c['Config']['User']==f'{os.getuid()}:{os.getgid()}'
        assert all('/var/run/docker.sock' != x['Destination'] for x in c['Mounts'])
    assert json.loads(docker('network','inspect',m['network']))[0]['Internal']
    (ROOT/'isolation.json').write_text(json.dumps(info,indent=2))
    record('container isolation',{'hostPorts':False,'internalNetwork':True,'nonRoot':True,'capabilities':[]})
    print('SETUP_READY',flush=True)

def tests():
    m=json.loads(MANIFEST.read_text()); manager=m['manager']
    safety.results=json.loads((ROOT/'results.json').read_text())
    def req(path, method='GET', body=None, proxy=False):
        url=path if path.startswith('http') else 'http://127.0.0.1:18787'+path
        q={'URL':url,'Method':method,'Body':json.dumps(body) if isinstance(body,dict) else body or ''}
        if proxy: q['Proxy']='http://127.0.0.1:17890'
        return json.loads(docker('exec',manager,'/fixture','request',json.dumps(q),timeout=25))
    def get(path):
        r=req(path); assert r['status']==200,r
        return json.loads(r['body'])
    def state(): return get('/api/core')
    def done():
        s=state(); return s if not s['busy'] else None
    def post(action, body, code=202):
        r=req('/api/core/'+action,'POST',body); assert r['status']==code,r
        return r
    def prepare(version, success=True):
        old=state()['current']; schema=get('/api/core/schema')['id']
        post('prepare',{'version':version,'expectedCurrent':old['id'] if old else ''})
        s=wait(done,90)
        assert (s['operation']['status']=='succeeded') == success,s
        assert s['current']==old and get('/api/core/schema')['id']==schema,s
        return s
    def switch(action='activate',success=True):
        s=state(); target=s['previous'] if action=='rollback' else s['prepared']
        post(action,{'id':target['id'],'expectedCurrent':s['current']['id'] if s['current'] else ''})
        s=wait(done,50)
        assert (s['operation']['status']=='succeeded') == success,s
        return s
    def verify(version, schema, warning=False):
        s=state(); assert s['current']['version']==version and s['running'],s
        sc=get('/api/core/schema')
        assert sc['coreVersion']==version and sc['version']==schema and sc['id']==s['current']['id'],sc.keys()
        assert bool(sc['warning'])==warning,sc['warning']
        r=req('http://source:8080/origin',proxy=True)
        assert r['status']==200 and r['body']=='sandbox-core-origin',r
        return {'core':version,'schema':schema,'warning':sc['warning'],'proxyTraffic':True}
    def fault(text):
        assert req('http://source:8080/fault','POST',text)['status']==200
    wait(state)
    workspace=ROOT/'data/work/.local/state.json'
    before=hashlib.sha256(workspace.read_bytes()).hexdigest()
    versions=get('/api/core/releases'); assert {r['version'] for r in versions}=={'v1.19.31','v1.19.32','v1.19.33'},versions
    prepare('v1.19.31'); switch(); record('install 31',verify('v1.19.31','1.19.31'))
    prepare('v1.19.32'); verify('v1.19.31','1.19.31'); switch(); record('update 32 and Schema',verify('v1.19.32','1.19.32'))
    switch('rollback'); record('rollback 31 and Schema',verify('v1.19.31','1.19.31'))
    switch('rollback'); verify('v1.19.32','1.19.32')
    prepare('v1.19.33'); switch(); record('33 with unpublished Schema fallback',verify('v1.19.33','1.19.32',True))
    switch('rollback'); record('rollback clears mismatch',verify('v1.19.32','1.19.32'))
    fault('mihomo-linux-amd64-v1-v1.19.31.gz')
    s=prepare('v1.19.31',False); fault('')
    record('corrupt core download rejected',{'error':s['operation']['error'],**verify('v1.19.32','1.19.32')})
    fault('meta-json-schema-1.19.31.tgz')
    s=prepare('v1.19.31'); fault('')
    assert s['prepared']['schemaVersion']=='1.19.32' and s['prepared']['schemaWarning'],s
    record('corrupt Schema not installed',{'retainedSchema':s['prepared']['schemaVersion']})
    prepare('v1.19.31')
    base=(ROOT/'fixtures/coreconfig.yaml').read_text()
    applied=state()['configuration']['hash']
    docker('exec',manager,'/fixture','config',base+'\n# edited after preparation\n')
    s=switch()
    assert s['configuration']['hash']==applied
    docker('exec',manager,'/fixture','config',base)
    record('committed configuration is independent of bootstrap file',verify('v1.19.31','1.19.31'))
    switch('rollback'); verify('v1.19.32','1.19.32')
    s=prepare('v1.19.31')
    docker('exec',manager,'/fixture','corrupt-candidate',s['prepared']['id'])
    s=switch(success=False)
    record('staged binary integrity rechecked',{'error':s['operation']['error'],**verify('v1.19.32','1.19.32')})
    s=prepare('v1.19.31'); target=s['prepared']; current=s['current']
    post('activate',{'id':target['id'],'expectedCurrent':'0'*32},409)
    post('activate',{'id':target['id'],'expectedCurrent':current['id']})
    post('prepare',{'version':'v1.19.33','expectedCurrent':current['id']},409)
    wait(lambda: '切换进程' in state()['operation']['phase'],15)
    wait(lambda: command('docker','exec',manager,'/fixture','kill-candidate',target['id'],check=False).returncode==0,10)
    s=wait(done); assert s['operation']['status']=='failed',s
    record('startup failure automatically restores core and Schema',{'error':s['operation']['error'],**verify('v1.19.32','1.19.32')})
    record('concurrent and stale requests rejected',True)
    docker('restart','--time','5',manager)
    wait(lambda: state().get('running') and not state()['busy'])
    record('manager restart restores confirmed bundle',verify('v1.19.32','1.19.32'))
    s=prepare('v1.19.31'); target=s['prepared']
    post('activate',{'id':target['id'],'expectedCurrent':s['current']['id']})
    wait(lambda: '切换进程' in state()['operation']['phase'],15)
    docker('kill','--signal','KILL',manager)
    docker('start',manager)
    wait(lambda: state().get('running') and not state()['busy'])
    record('interrupted update recovers last confirmed bundle',verify('v1.19.32','1.19.32'))
    assert hashlib.sha256(workspace.read_bytes()).hexdigest()==before
    record('workspace draft unchanged',before)
    record('existing containers unchanged',safety.compare_baseline())
    (ROOT/'manager.log').write_text(docker('logs',manager))
    (ROOT/'final-state.json').write_text(json.dumps(state(),indent=2,ensure_ascii=False))
    print('TESTS_COMPLETE',flush=True)

if __name__=='__main__':
    if sys.argv[1]=='setup': setup()
    elif sys.argv[1]=='tests': tests()
    elif sys.argv[1]=='cleanup': safety.cleanup()
    else: raise ValueError('unknown action')
