import base64, fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios

master, slave = pty.openpty()
def setup():
    os.setsid()
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, preexec_fn=setup, close_fds=True)
device = os.ttyname(slave)
os.close(slave)
def emit(row):
    print(json.dumps(row), flush=True)
emit({'kind':'started','pid':child.pid,'device':device,'native':'unix-pty'})
pending = b''
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin.buffer], [], [], .1)
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                data = b''
            if data: emit({'kind':'data','data':base64.b64encode(data).decode()})
        if sys.stdin.buffer in ready:
            chunk = os.read(sys.stdin.fileno(), 65536)
            if not chunk: break
            pending += chunk
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                row = json.loads(line)
                if row['kind']=='input': os.write(master, base64.b64decode(row['data']))
                elif row['kind']=='resize':
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', row['rows'], row['cols'], 0, 0))
                    os.killpg(child.pid, signal.SIGWINCH)
                elif row['kind']=='kill': os.killpg(child.pid, signal.SIGTERM)
        if child.poll() is not None:
            emit({'kind':'exit','code':child.returncode,'pid':child.pid}); break
finally:
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        try: child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL); child.wait()
    os.close(master)
