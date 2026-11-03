"""Additional review cases, run exclusively inside run.py's owned containers."""
import json


def run_review(root, m, create, docker, command, record, wait, fixture_ip, node_ip, client_ip):
    config = root/'config'
    cert = json.loads(docker('exec', m['source'], '/fixture', 'certificate'))
    (config/'cert.pem').write_text(cert['cert']); (config/'key.pem').write_text(cert['key'])
    # Only restart the sandbox's own server, keeping the same container/address.
    docker('stop', '--time', '3', m['node'])
    (config/'node.yaml').write_text((root/'protocols-node.json').read_text().replace('FIXTURE_IP', fixture_ip))
    docker('start', m['node'])
    for name in ['protocols-client', 'protocols-renamed']:
        (config/(name+'.yaml')).write_text((root/(name+'.yaml')).read_text().replace('FIXTURE_IP',fixture_ip).replace('NODE_IP',node_ip))
    api='http://'+client_ip+':9090'
    def req(url, method='GET', body=None, proxy=False, cid=None, headers=None):
        q={'URL':url,'Method':method,'Body':json.dumps(body) if body is not None else '', 'Headers':headers or {}}
        if proxy: q['Proxy']='http://'+client_ip+':7890'
        return json.loads(docker('exec',cid or m['source'],'/fixture','request',json.dumps(q),timeout=15))
    def get(path):
        r=req(api+path);assert r.get('status')==200,r;return json.loads(r['body'])
    def reload(name):
        r=req(api+'/configs?force=true','PUT',{'path':'/config/'+name+'.yaml'});assert r.get('status')==204,r
    check=command('docker','exec',m['client'],'/mihomo','-t','-d','/data','-f','/config/protocols-client.yaml',check=False)
    assert check.returncode==0,check.stdout+check.stderr
    record('protocol fixtures pass native -t',check.stdout+check.stderr)
    reload('protocols-client')
    cases=json.loads((root/'protocols-cases.json').read_text())
    wait(lambda:len(get('/proxies/Protocols')['all'])==len(cases))
    def select(name,group='Protocols'):
        r=req(api+'/proxies/'+group,'PUT',{'name':name});assert r.get('status')==204,r
    def traffic():
        r=req('http://origin.sandbox.test:8080/ok',proxy=True)
        assert r.get('status')==200,r
        b=json.loads(r['body']);assert b['marker']=='isolated-origin' and b['remote'].rsplit(':',1)[0]==node_ip,b
        return b
    for case in cases:
        select(case['name'])
        record('protocol TCP '+case['name'],wait(traffic))
        if case['udp']:
            r=json.loads(docker('exec',m['source'],'/fixture','udp',client_ip,fixture_ip,timeout=15))
            assert not r.get('error'),r
            b=json.loads(r['body']);assert b['marker']=='isolated-udp' and b['payload']=='review-udp-probe' and b['remote'].rsplit(':',1)[0]==node_ip,b
            record('protocol UDP '+case['name'],b)
    reload('protocols-renamed');select('SS','ProtocolsRenamed')
    record('renamed group with sub-rules and src parameter routes',traffic())
    invalid=(config/'protocols-client.yaml').read_text().replace('password: sandbox-test-only','password: wrong-test-password')
    (config/'bad-auth.yaml').write_text(invalid)
    reload('bad-auth');select('Trojan')
    r=req('http://origin.sandbox.test:8080/ok',proxy=True)
    assert r.get('status')!=200,r
    record('wrong credentials cannot silently bypass proxy',r)
    reload('protocols-client');select('Trojan');record('correct credentials recover traffic',wait(traffic))
    # Release core resources before starting the manager. Peak limits stay <=640 MiB.
    docker('stop','--time','3',m['client'],m['node'])
    (config/'example.yaml').write_text('mode: rule\nrules: ["MATCH,DIRECT"]\n')
    manager=create('manager',['manager'],memory='128m',cpus='0.25')
    docker('start',manager)
    base='http://127.0.0.1:18787/api'
    def call(path,method='GET',body=None,headers=None):return req(base+path,method,body,cid=manager,headers=headers)
    def state():
        r=call('/state');assert r.get('status')==200,r;return json.loads(r['body'])
    before=wait(state);draft='mode: global\nrules: ["MATCH,DIRECT"]\n'
    r=call('/draft','PUT',{'text':draft},{'If-Match':before['revision']});assert r.get('status')==200,r
    saved=state();assert saved['draft']==draft and saved['applied']==before['applied'] and saved['runtime']==before['runtime']
    record('Linux manager save preserves runtime',{'revisionChanged':saved['revision']!=before['revision'],'runtimeUnchanged':True})
    r=call('/draft','PUT',{'text':'mode: direct\n'},{'If-Match':before['revision']});assert r.get('status')==409,r
    assert state()['draft']==draft;record('Linux manager stale revision rejected',r['status'])
    bad='proxies: [{name: a, type: direct, dialer-proxy: missing}]\nrules: ["RULE-SET,missing,DIRECT"]\n'
    r=call('/draft','PUT',{'text':bad},{'If-Match':saved['revision']});assert r.get('status')==200,r
    r=call('/apply','POST',{'revision':state()['revision']});assert r.get('status')==422,r
    assert state()['applied']==before['applied'] and state()['runtime']==before['runtime']
    record('Linux manager invalid references cannot apply',r['status'])
    r=call('/state',headers={'Host':'attacker.example:18787'});assert r.get('status')==403,r
    record('Linux manager rebinding read rejected',r['status'])
    r=call('/runtime','PATCH',{'mode':'direct'},{'Origin':'https://attacker.example'});assert r.get('status')==403,r
    record('Linux manager cross-origin mutation rejected',r['status'])
    for role in ['node','client','manager']:
        p=command('docker','logs',m[role],check=False);(root/('review-'+role+'.log')).write_text(p.stdout+p.stderr)
