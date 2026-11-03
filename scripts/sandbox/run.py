"""Run only in a newly created task directory on a Docker host.

Inputs: fixture, mihomo, client.yaml, renamed.yaml, release.json, baseline.json.
No credentials, host ports, privileged access or access to existing containers.
Use `python3 run.py cleanup` to remove only IDs recorded in manifest.json.
"""
import hashlib
import ipaddress
import json
from pathlib import Path
import subprocess
import sys
import time
import traceback

ROOT = Path(__file__).resolve().parent
LABEL = 'io.mihomomanager.sandbox'
NAME = ROOT.name
assert NAME.startswith('mm-sandbox-') and ROOT.parent == Path.home()
MANIFEST = ROOT / 'manifest.json'
RESULTS = ROOT / 'results.json'
results = []


def command(*args, timeout=60, check=True):
    p = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=timeout)
    if check and p.returncode:
        raise RuntimeError(f'{args[:3]}: {p.stderr or p.stdout}')
    return p


def docker(*args, **kwargs):
    return command('docker', *args, **kwargs).stdout.strip()


def record(name, detail):
    results.append({'test': name, 'passed': True, 'detail': detail})
    RESULTS.write_text(json.dumps(results, indent=2, ensure_ascii=False))
    print('PASS', name, flush=True)


def snapshot():
    ids = docker('ps', '-aq').split()
    containers = json.loads(docker('inspect', *ids)) if ids else []
    return [{'Id': c['Id'], 'Name': c['Name'], 'Image': c['Image'],
             'StartedAt': c['State']['StartedAt'], 'RestartCount': c['RestartCount'],
             'Status': c['State']['Status'], 'Health': c['State'].get('Health', {}).get('Status'),
             'Ports': c['HostConfig']['PortBindings'], 'Networks': sorted(c['NetworkSettings']['Networks'])}
            for c in containers]


def compare_baseline():
    base = json.loads((ROOT / 'baseline.json').read_text())
    after = snapshot()
    by_id = {c['Id']: c for c in after}
    differences = [{'before': c, 'after': by_id.get(c['Id'])} for c in base['containers'] if c != by_id.get(c['Id'])]
    current_routes = json.loads(command('ip', '-j', 'route').stdout)
    data = {'existingContainers': len(base['containers']), 'containerDifferences': differences,
            'existingNetworksPresent': set(base['networks']) <= set(docker('network', 'ls', '-q', '--no-trunc').split()),
            'volumesUnchanged': sorted(base['volumes']) == sorted(docker('volume', 'ls', '-q').split()),
            'originalRoutesPresent': all(r in current_routes for r in base['routes'])}
    (ROOT / 'comparison.json').write_text(json.dumps(data, indent=2))
    assert not differences and data['existingNetworksPresent'] and data['volumesUnchanged'] and data['originalRoutesPresent'], data
    return data


def cleanup():
    m = json.loads(MANIFEST.read_text())
    assert m['name'] == NAME
    for cid in reversed(m['containers']):
        probe = command('docker', 'inspect', cid, check=False)
        if probe.returncode: continue
        c = json.loads(probe.stdout)[0]
        assert c['Config']['Labels'].get(LABEL) == NAME
        if c['State']['Running']: docker('stop', '--time', '3', cid)
        docker('rm', cid)
    if m.get('network'):
        probe = command('docker', 'network', 'inspect', m['network'], check=False)
        if probe.returncode == 0:
            n = json.loads(probe.stdout)[0]
            assert n['Labels'].get(LABEL) == NAME and not n['Containers']
            docker('network', 'rm', m['network'])
    if m.get('image'):
        probe = command('docker', 'image', 'inspect', m['image'], check=False)
        if probe.returncode == 0:
            im = json.loads(probe.stdout)[0]
            assert im['Config']['Labels'].get(LABEL) == NAME
            docker('image', 'rm', m['image'])
    comparison = compare_baseline()
    remaining = docker('ps', '-aq', '--filter', f'label={LABEL}={NAME}').split()
    comparison['testContainersRemaining'] = remaining
    comparison['testNetworksRemaining'] = docker('network', 'ls', '-q', '--filter', f'label={LABEL}={NAME}').split()
    comparison['routesRestoredExactly'] = json.loads(command('ip', '-j', 'route').stdout) == json.loads((ROOT/'baseline.json').read_text())['routes']
    (ROOT / 'cleanup.json').write_text(json.dumps(comparison, indent=2))
    print(json.dumps(comparison), flush=True)


def main():
    if len(sys.argv) > 1 and sys.argv[1] == 'cleanup': cleanup(); return
    if len(sys.argv) > 1 and sys.argv[1] == 'baseline':
        assert not MANIFEST.exists() and not (ROOT/'baseline.json').exists()
        base = {'containers':snapshot(),
                'networks':docker('network','ls','-q','--no-trunc').split(),
                'volumes':docker('volume','ls','-q').split(),
                'routes':json.loads(command('ip','-j','route').stdout),
                'images':docker('image','ls','-q','--no-trunc').split()}
        (ROOT/'baseline.json').write_text(json.dumps(base,indent=2))
        print('Recorded baseline for',len(base['containers']),'existing containers'); return
    assert not MANIFEST.exists(), 'Existing run: inspect/clean it explicitly; never overwrite ownership records'
    assert command('docker', 'image', 'inspect', NAME+':test', check=False).returncode != 0, 'Test image name already exists'
    m = {'name': NAME, 'containers': []}
    def save(): MANIFEST.write_text(json.dumps(m, indent=2))
    save()
    fixtures = ROOT / 'fixtures'; fixtures.mkdir()
    config = ROOT / 'config'; config.mkdir()
    # Docker daemon may need to traverse the private task dir; containers see
    # only these explicit read-only subdirectories, never the Docker socket.
    extra = 'COPY manager /manager\n' if (ROOT/'manager').exists() else ''
    (ROOT / 'Dockerfile').write_text('FROM scratch\nCOPY mihomo /mihomo\nCOPY fixture /fixture\n'+extra+'USER 65532:65532\nENTRYPOINT ["/fixture"]\n')
    (ROOT / '.dockerignore').write_text('*\n!Dockerfile\n!mihomo\n!fixture\n!manager\n')
    (ROOT / 'fixture').chmod(0o755)
    if (ROOT/'manager').exists(): (ROOT/'manager').chmod(0o755)
    build = command('docker', 'build', '--network', 'none', '--label', f'{LABEL}={NAME}', '-t', NAME+':test', '.', timeout=120)
    (ROOT / 'build.log').write_text(build.stdout+build.stderr)
    m['image'] = docker('image', 'inspect', '--format', '{{.Id}}', NAME+':test'); save()
    m['network'] = docker('network', 'create', '--internal', '--label', f'{LABEL}={NAME}', NAME); save()

    def create(role, args, network=True, memory='192m', cpus='0.25'):
        cid = docker('create', '--name', NAME+'-'+role, '--label', f'{LABEL}={NAME}',
                     '--network', m['network'] if network else 'none',
                     '--network-alias', 'fixture' if role == 'source' else role,
                     '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
                     '--user', '65532:65532', '--memory', memory, '--memory-swap', memory,
                     '--env', 'SAFE_PATHS=/config',
                     '--cpus', cpus, '--pids-limit', '96', '--restart', 'no',
                     '--log-driver', 'json-file', '--log-opt', 'max-size=2m', '--log-opt', 'max-file=1',
                     '--tmpfs', '/data:rw,noexec,nosuid,size=32m,uid=65532,gid=65532',
                     '--tmpfs', '/tmp:rw,noexec,nosuid,size=8m,uid=65532,gid=65532',
                     '--mount', f'type=bind,src={fixtures},dst=/fixtures,readonly',
                     '--mount', f'type=bind,src={config},dst=/config,readonly',
                     m['image'], *args)
        m['containers'].append(cid); m[role] = cid; save(); return cid

    fixture = create('source', [], memory='64m')
    docker('start', fixture)
    def ip(cid): return next(iter(json.loads(docker('inspect', cid))[0]['NetworkSettings']['Networks'].values()))['IPAddress']
    fixture_ip = ip(fixture)
    node = create('node', ['boot', '-f', '/config/node.yaml'])
    # A created container gets its address only when started. It does not need
    # the client address; all test domains point to the isolated source/origin.
    hosts = '\n'.join(f'  {host}: {fixture_ip}' for host in ['fixture','http.sandbox.test','inline.sandbox.test','file.sandbox.test','geo.sandbox.test','update.sandbox.test','plain.sandbox.test'])
    (config/'node.yaml').write_text('mode: rule\nlog-level: info\nipv6: false\nfind-process-mode: off\ndns: {enable: false}\nhosts:\n'+hosts+'\nlisteners:\n'+''.join(f'  - name: ss-{port}\n    type: shadowsocks\n    listen: 0.0.0.0\n    port: {port}\n    cipher: aes-128-gcm\n    password: sandbox-test-only\n' for port in [8388,8389])+'rules: [MATCH,DIRECT]\n')
    # Correct YAML sequence: MATCH,DIRECT must be a single rule string.
    (config/'node.yaml').write_text((config/'node.yaml').read_text().replace('rules: [MATCH,DIRECT]', 'rules:\n  - MATCH,DIRECT'))
    docker('start',node); node_ip=ip(node)
    for variant in ['client','renamed']:
        (config/(variant+'.yaml')).write_text((ROOT/(variant+'.yaml')).read_text().replace('FIXTURE_IP',fixture_ip).replace('NODE_IP',node_ip))
    for version,name in [('v1','Subscribed'),('v2','SubscribedV2')]:
        (fixtures/f'sub-{version}.yaml').write_text(f'proxies:\n  - name: {name}\n    type: ss\n    server: {node_ip}\n    port: 8389\n    cipher: aes-128-gcm\n    password: sandbox-test-only\n')
    (fixtures/'rules-v1.yaml').write_text("payload:\n  - 'http.sandbox.test'\n")
    (fixtures/'rules-v2.yaml').write_text("payload:\n  - 'http.sandbox.test'\n  - 'update.sandbox.test'\n")
    (fixtures/'file.yaml').write_text("payload:\n  - 'file.sandbox.test'\n")
    def field(tag,data):
        assert len(data)<128
        return bytes([tag*8+2,len(data)])+data
    # Tiny valid geodata using the pinned Mihomo config.proto wire schema.
    (fixtures/'geosite.dat').write_bytes(field(1,field(1,b'SANDBOX')+field(2,b'\x08\x03'+field(2,b'geo.sandbox.test'))))
    (fixtures/'geoip.dat').write_bytes(field(1,field(1,b'SB')+field(2,field(1,ipaddress.ip_address(fixture_ip).packed)+b'\x10\x20')))
    converted = subprocess.run(['docker','exec',fixture,'/mihomo','convert-ruleset','domain','yaml','/fixtures/file.yaml','/dev/stdout'],capture_output=True,timeout=20)
    assert converted.returncode == 0 and converted.stdout, converted.stderr
    (fixtures/'file.mrs').write_bytes(converted.stdout)
    (fixtures/'file.mrs').chmod(0o644)
    record('native MRS conversion', {'sha256':hashlib.sha256((fixtures/'file.mrs').read_bytes()).hexdigest()})
    client = create('client',['boot','-f','/config/client.yaml'],memory='384m',cpus='0.5')
    docker('start',client); client_ip=ip(client)
    assert client_ip, docker('logs', client)
    api='http://'+client_ip+':9090'
    origin='http://'+fixture_ip+':8080'

    def req(url,method='GET',body=None,proxy=False):
        payload={'URL':url,'Method':method,'Body':json.dumps(body) if body is not None else ''}
        if proxy: payload['Proxy']='http://'+client_ip+':7890'
        return json.loads(docker('exec',fixture,'/fixture','request',json.dumps(payload),timeout=12))
    def get(path):
        r=req(api+path); assert r.get('status')==200,r;return json.loads(r['body'])
    def wait(fn,seconds=25):
        end=time.monotonic()+seconds; last=None
        while time.monotonic()<end:
            try:
                last=fn()
                if last:return last
            except Exception as e:last=str(e)
            time.sleep(0.5)
        raise AssertionError(str(last))
    def group(): return get('/proxies/Mixed')
    def select(name):
        r=req(api+'/proxies/Mixed','PUT',{'name':name});assert r.get('status')==204,r
    def traffic(host,expected):
        r=req('http://'+host+':8080/ok',proxy=True);assert r.get('status')==200,r
        b=json.loads(r['body']);assert b['marker']=='isolated-origin',b
        assert b['remote'].rsplit(':',1)[0]==expected,b
        return b
    wait(lambda: get('/version'))
    version=get('/version'); record('real core startup',version)
    wait(lambda:'Subscribed' in group()['all'])
    assert {'Manual','Subscribed'} <= set(group()['all'])
    record('manual and subscription in one group',group())
    for name in ['Manual','Subscribed']:
        select(name)
        record('Shadowsocks TCP via '+name,traffic('http.sandbox.test',node_ip))
    for host in ['inline.sandbox.test','file.sandbox.test','geo.sandbox.test',fixture_ip]:
        record('rule match '+host,traffic(host,node_ip))
    # GeoIP fixture matches the origin IP too, so a plain hostname routes through
    # GEOIP after DNS resolution. HTTP rule changes are verified with core logs.
    stats=json.loads(req(origin+'/stats')['body'])
    assert all(stats['counts'].get('/'+p,0)>=1 for p in ['sub.yaml','rules.yaml','geoip.dat','geosite.dat']),stats
    record('native provider and GEO downloads',stats)
    v=command('docker','exec',client,'/mihomo','-t','-d','/data','-f','/config/client.yaml',check=False)
    assert v.returncode==0,v.stdout+v.stderr
    record('mihomo -t accepts manager-generated YAML',v.stdout+v.stderr)
    before=stats['counts'].copy()
    req(origin+'/control?sub=v2&rules=v2')
    wait(lambda:'SubscribedV2' in group()['all'])
    wait(lambda:get('/providers/rules')['providers']['HTTP'].get('ruleCount')==2)
    assert 'Manual' in group()['all'] and 'Subscribed' not in group()['all']
    select('SubscribedV2'); record('scheduled provider update preserves manual node',traffic('http.sandbox.test',node_ip))
    record('scheduled rule-provider update',traffic('update.sandbox.test',node_ip))
    req(origin+'/control?sub=invalid&rules=invalid')
    ps=req(api+'/providers/proxies/Subscription','PUT')
    rs=req(api+'/providers/rules/HTTP','PUT')
    assert ps.get('status',0)>=400 and rs.get('status',0)>=400,(ps,rs)
    assert 'SubscribedV2' in group()['all'] and get('/providers/rules')['providers']['HTTP']['ruleCount']==2
    record('invalid resource update retains last working state',{'subscription':ps,'rules':rs,'traffic':traffic('http.sandbox.test',node_ip)})
    req(origin+'/control?sub=offline&rules=offline')
    ps=req(api+'/providers/proxies/Subscription','PUT');rs=req(api+'/providers/rules/HTTP','PUT')
    assert ps.get('status',0)>=400 and rs.get('status',0)>=400,(ps,rs)
    record('source outage retains last working state',{'subscription':ps,'rules':rs,'traffic':traffic('http.sandbox.test',node_ip)})
    req(origin+'/control?sub=v2&rules=v2')
    geo_before=json.loads(req(origin+'/stats')['body'])['counts']
    geo=req(api+'/configs/geo','POST')
    if geo.get('status')==404: geo=req(api+'/upgrade/geo','POST')
    assert geo.get('status') in [200,204],geo
    geo_after=json.loads(req(origin+'/stats')['body'])['counts']
    assert geo_after['/geosite.dat']>geo_before['/geosite.dat'] and geo_after['/geoip.dat']>geo_before['/geoip.dat']
    record('native GEO update',{'response':geo,'counts':geo_after,'traffic':traffic('geo.sandbox.test',node_ip)})
    # Rename fixtures are generated by the manager, including reference rewrites.
    r=req(api+'/configs?force=true','PUT',{'path':'/config/renamed.yaml'})
    assert r.get('status')==204,r
    wait(lambda:{'ManualRenamed','SubscribedV2'} <= set(group()['all']))
    assert 'SubscriptionRenamed' in get('/providers/proxies')['providers']
    assert 'HTTPRenamed' in get('/providers/rules')['providers']
    select('ManualRenamed');record('renamed node/provider references load and route',traffic('http.sandbox.test',node_ip))
    invalid=(config/'renamed.yaml').read_text().replace('RULE-SET,HTTPRenamed,Mixed','RULE-SET,MISSING,Mixed')
    (config/'invalid.yaml').write_text(invalid)
    v=command('docker','exec',client,'/mihomo','-t','-d','/data','-f','/config/invalid.yaml',check=False)
    assert v.returncode!=0
    record('core rejects nonexistent rule provider',v.stdout+v.stderr)
    r=req(api+'/configs?force=true','PUT',{'path':'/config/invalid.yaml'})
    assert r.get('status',0)>=400,r
    record('failed reload keeps working configuration',{'response':r,'traffic':traffic('http.sandbox.test',node_ip)})
    inspect=json.loads(docker('inspect',fixture,node,client))
    for c in inspect:
        h=c['HostConfig'];assert not h['Privileged'] and not h['PortBindings'] and h['ReadonlyRootfs'] and h['CapDrop']==['ALL']
        assert h['Memory'] and h['NanoCpus'] and h['PidsLimit']==96
        assert c['Config']['User']=='65532:65532'
    n=json.loads(docker('network','inspect',m['network']))[0];assert n['Internal']
    (ROOT/'isolation.json').write_text(json.dumps({'containers':inspect,'network':n},indent=2))
    record('container isolation and resource limits',{'hostPorts':0,'internalNetwork':True,'nonRoot':True,'capabilities':'none'})
    log = command('docker','logs',client).stdout
    matches = ['RuleSet(HTTP)', 'RuleSet(File)', 'RuleSet(Inline)', 'GeoSite(sandbox)', 'GeoIP(sb)', 'RuleSet(HTTPRenamed)']
    for rule in matches:
        assert 'match '+rule+' using Mixed[' in log, rule
    assert 'update.sandbox.test:8080 match RuleSet(HTTP)' in log
    record('core logs confirm each rule type actually matched', matches)
    if (ROOT/'protocols-client.yaml').exists():
        from review import run_review
        run_review(ROOT, m, create, docker, command, record, wait, fixture_ip, node_ip, client_ip)
    record('existing services unchanged',compare_baseline())
    for role in ['source','node','client']:
        p=command('docker','logs',m[role],check=False);(ROOT/(role+'.log')).write_text(p.stdout+p.stderr)
    print(json.dumps({'passed':len(results),'resultFile':str(RESULTS)}),flush=True)


if __name__ == '__main__':
    try: main()
    except Exception as e:
        results.append({'test':'run interrupted','passed':False,'detail':str(e)})
        RESULTS.write_text(json.dumps(results,indent=2,ensure_ascii=False))
        if MANIFEST.exists():
            m=json.loads(MANIFEST.read_text())
            for role in ['source','node','client']:
                if role in m:
                    p=command('docker','logs',m[role],check=False);(ROOT/(role+'.log')).write_text(p.stdout+p.stderr)
        traceback.print_exc();sys.exit(1)
