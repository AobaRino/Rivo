"""Run a command over an isolated QEMU serial console; socket is local to sandbox.

Usage: python3 vm-console.py /work/console.sock 'command'
Only used for the disposable firmware VM, never for a production router.
"""
import re
import select
import socket
import sys
import time
import uuid

console = socket.socket(socket.AF_UNIX)
console.connect(sys.argv[1])
console.setblocking(False)
marker = "MM_DONE_" + uuid.uuid4().hex
console.sendall(b"\x03\n")
time.sleep(0.5)
while select.select([console], [], [], 0)[0]:
    console.recv(65536)
command = sys.argv[2]
# Split the marker so an echoed command cannot be mistaken for its result.
wrapped = "{ " + command + "; }; mm_rc=$?; printf '\\nMM_DONE_%s:%s\\n' '" + marker[8:] + "' \"$mm_rc\"\n"
console.sendall(wrapped.encode())
output = bytearray()
deadline = time.monotonic() + 45
while time.monotonic() < deadline:
    if not select.select([console], [], [], 1)[0]:
        continue
    chunk = console.recv(65536)
    if not chunk:
        break
    output.extend(chunk)
    match = re.search(re.escape(marker.encode()) + rb":(\d+)", output)
    if match:
        print(output.decode("utf-8", "replace"))
        sys.exit(int(match.group(1)))
print(output.decode("utf-8", "replace"))
raise SystemExit("QEMU console command timed out")
