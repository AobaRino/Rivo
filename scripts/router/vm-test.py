"""Integration checks in the disposable ImmortalWrt QEMU VM only.

Run inside the test container after installing both signed APKs. The firmware
uses its fresh-image root account (empty password); never point at a real router.
"""
import json
import re
import subprocess
import time
import urllib.error
import urllib.request

BASE = 'http://127.0.0.1:18788'
PREFIX = '/cgi-bin/mihomo-manager'
passed = []

def check(name, condition):
    assert condition, name
    passed.append(name)
    print('PASS', name, flush=True)

def vm(command):
    result = subprocess.run(['python3', '/work/vm-console.py', '/work/console.sock', command], capture_output=True, text=True, timeout=50)
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout

def http(method, path, body=None, session='', headers=None):
    h = {'Content-Type':'application/json', **(headers or {})}
    if session:
        h['Authorization'] = 'Bearer ' + session
    request = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers=h)
    try:
        response = urllib.request.urlopen(request, timeout=20)
    except urllib.error.HTTPError as e:
        response = e
    data = response.read()
    try:
        return response.status, json.loads(data)
    except ValueError:
        return response.status, data.decode(errors='replace')

def api(method,path,body=None,session='',headers=None):
    if method == 'PUT' and path == '/api/draft':
        body = {**body, 'revision':(headers or {}).get('If-Match','')}
        headers = {k:v for k,v in (headers or {}).items() if k != 'If-Match'}
    return http(method, PREFIX+path, body, session, headers)

status, login = http('POST','/ubus/', {'jsonrpc':'2.0','id':1,'method':'call','params':['0'*32,'session','login',{'username':'root','password':''}]})
assert status == 200 and login['result'][0] == 0, login
session = login['result'][1]['ubus_rpc_session']
check('anonymous denied', api('GET','/api/state')[0] == 401)
check('invalid session denied', api('GET','/api/state',session='1'*32)[0] == 403)
status, initial = api('GET','/api/state',session=session)
check('authenticated workspace', status == 200 and initial['simulation'])
original = initial['draft'].replace('\n# sandbox persistence check\n','')
if original != initial['draft']:
    status, initial = api('PUT','/api/draft',{'text':original},session,{'If-Match':initial['revision']})
    assert status == 200
check('core disabled', api('GET','/api/core',session=session)[1]['enabled'] is False)
check('apply blocked', api('POST','/api/apply',{},session)[0] == 404)
check('core update blocked', api('POST','/api/core/prepare',{},session)[0] == 404)
check('cross origin denied', api('PUT','/api/draft',{'text':initial['draft']},session,{'Origin':'https://invalid.example'})[0] == 403)
check('stale write denied', api('PUT','/api/draft',{'text':'mode: rule\n'},session,{'If-Match':'f'*64})[0] == 409)

readonly = vm("ubus call session create | jsonfilter -e @.ubus_rpc_session")
readonly = re.search(r'^([0-9a-f]{32})$',readonly,re.M).group(1)
vm("ubus call session grant '"+json.dumps({'ubus_rpc_session':readonly,'scope':'ubus','objects':[['mihomo-manager','read']]})+"'")
check('read-only access allowed', api('GET','/api/state',session=readonly)[0] == 200)
check('read-only save denied', api('PUT','/api/draft',{'text':'mode: rule\n'},readonly,{'If-Match':initial['revision']})[0] == 403)

draft = initial['draft'] + '\n# sandbox persistence check\n'
status, saved = api('PUT','/api/draft',{'text':draft},session,{'If-Match':initial['revision']})
assert status == 200, (status, saved)
check('save preserved exact YAML', status == 200 and saved['draft'] == draft)
check('save did not apply', saved['applied'] == initial['applied'])
vm('/etc/init.d/mihomo-manager restart')
for _ in range(30):
    status, current = api('GET','/api/state',session=session)
    if status == 200: break
    time.sleep(.3)
check('state survived restart', status == 200 and current['draft'] == draft)

pid_command = "ubus call service list '{\"name\":\"mihomo-manager\"}' | jsonfilter -e '@[\"mihomo-manager\"].instances.manager.pid'"
before = re.search(r'^(\d+)$',vm(pid_command),re.M).group(1)
vm('kill -KILL '+before)
for _ in range(40):
    time.sleep(.3)
    status, current = api('GET','/api/state',session=session)
    if status == 200: break
after = re.search(r'^(\d+)$',vm(pid_command),re.M).group(1)
check('procd respawned service', before != after and status == 200)
check('state survived crash', current['draft'] == draft)
props = vm("ls -l /etc/mihomo-manager/state.json /var/run/mihomo-manager/api.sock")
check('private state and socket', len(re.findall(r'[-s]rw-------\s+\d+\s+mihomomgr\s+mihomomgr',props)) == 2)
vm('sha256sum -c /tmp/mm-net-before.sha')
vm('test "$(ip route show table all)" = "$(cat /tmp/mm-route-before)"')
vm('test "$(pidof dnsmasq)" = "$(cat /tmp/mm-dns-before)"')
check('network configuration routes and DNS process unchanged', True)
check('no TCP proxy or management listener', not re.search(r':(?:7890|9090|18787)\s',vm('netstat -lnt')))
api('PUT','/api/draft',{'text':initial['draft']},session,{'If-Match':current['revision']})
vm("ubus call session destroy '"+json.dumps({'ubus_rpc_session':readonly})+"'")
check('revoked session denied', api('GET','/api/state',session=readonly)[0] == 403)
print(json.dumps({'passed':len(passed)},ensure_ascii=False))
