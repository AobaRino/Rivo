"""Exercise the actual master init script against isolated service/network doubles.

Run on Linux. No real init services, routes, DNS or firewall are touched.
"""
from pathlib import Path
import os
import subprocess
import tempfile

source = Path(__file__).resolve().parents[2] / 'packaging/openwrt/mihomo-manager/files/mihomo-manager-system.init'
with tempfile.TemporaryDirectory(prefix='mihomo-master-test-') as directory:
    root = Path(directory)
    for path in ('etc/init.d', 'etc/mihomo-manager-runtime', 'usr/libexec', 'bin', 'state'):
        (root/path).mkdir(parents=True, exist_ok=True)
    def script(path, content):
        target=root/path
        target.write_text(content)
        target.chmod(0o700)
    state = root/'state'
    script('bin/curl', f'#!/bin/sh\ntest -e "{state}/mihomo-manager-core.running"\n')
    network=f'''#!/bin/sh
echo "network $1" >> "{state}/calls"
case "$1" in
 prepare) touch "{root}/etc/mihomo-manager-runtime/network-pending" ;;
 on) test -e "{state}/mihomo-manager-core.running" || exit 1
     touch "{state}/owned-rules" "{state}/dns-forwarded" ;;
 commit) touch "{root}/etc/mihomo-manager-runtime/network-enabled" ;;
 off) rm -f "{state}/owned-rules" "{state}/dns-forwarded" "{root}/etc/mihomo-manager-runtime/network-enabled" "{root}/etc/mihomo-manager-runtime/network-pending" ;;
esac
'''
    script('usr/libexec/mihomo-manager-network',network)
    for name in ['mihomo-manager','mihomo-manager-core','mihomo-manager-network','mihomo-manager-apply']:
        script('etc/init.d/'+name, f'''#!/bin/sh
echo "{name} $1" >> "{state}/calls"
case "$1" in
 start) touch "{state}/{name}.running" ;;
 stop) rm -f "{state}/{name}.running"
       if [ "{name}" = mihomo-manager-network ]; then "{root}/usr/libexec/mihomo-manager-network" off; fi ;;
 disable) rm -f "{state}/{name}.boot" ;;
esac
''')
    text=source.read_text().replace('/etc/',str(root)+'/etc/').replace('/usr/libexec/',str(root)+'/usr/libexec/')
    script('master.sh',text+'\n"$1"\n')
    env={**os.environ,'PATH':str(root/'bin')+':'+os.environ['PATH']}
    def run(action): subprocess.run(['sh',str(root/'master.sh'),action],env=env,check=True)
    for name in ['mihomo-manager','mihomo-manager-core','mihomo-manager-network','mihomo-manager-apply']:
        (state/(name+'.running')).touch();(state/(name+'.boot')).touch()
    runtime=root/'etc/mihomo-manager-runtime'
    (runtime/'active.yaml').write_text('mode: rule\n')
    (runtime/'network-enabled').touch();(state/'owned-rules').touch();(state/'dns-forwarded').touch()
    run('stop')
    assert not list(state.glob('*.running')), 'A service survived shutdown'
    assert not (state/'owned-rules').exists() and not (state/'dns-forwarded').exists()
    assert (runtime/'network-wanted').exists() and (runtime/'active.yaml').read_text()=='mode: rule\n'
    calls=(state/'calls').read_text()
    assert calls.index('network off') < calls.index('mihomo-manager-core stop') < calls.index('mihomo-manager stop')
    assert not (state/'mihomo-manager.boot').exists() and not (state/'mihomo-manager-core.boot').exists()
    run('stop')  # Idempotent shutdown.
    disabled=root/'etc/mihomo-manager.disabled';disabled.touch()
    run('start');assert not list(state.glob('*.running')), 'Package start bypassed master off'
    disabled.unlink();run('start')
    assert (state/'mihomo-manager.running').exists() and (state/'mihomo-manager-core.running').exists()
    assert (state/'owned-rules').exists() and (state/'dns-forwarded').exists()
    run('stop');(runtime/'active.yaml').unlink()
    for name in ['mihomo-manager','mihomo-manager-core','mihomo-manager-network']:
        (state/(name+'.boot')).touch()
    run('start')
    assert (state/'mihomo-manager.running').exists() and not (state/'mihomo-manager-core.running').exists()
    assert not any((state/(name+'.boot')).exists() for name in ['mihomo-manager','mihomo-manager-core','mihomo-manager-network'])
    assert not (state/'owned-rules').exists(), 'Fresh installation took over the network'
    print('PASS: ordered shutdown, rule/DNS cleanup, config retention, idempotence, disabled-start guard, re-enable, fresh install')
