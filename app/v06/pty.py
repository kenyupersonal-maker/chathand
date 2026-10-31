#!/usr/bin/env python3
"""Small PTY transport; the caller applies Seatbelt before invoking this helper."""
import os, sys, pty, signal, select, time, errno, fcntl, termios, struct
if len(sys.argv)<2:
    print('PTY_PROGRAM_MISSING',file=sys.stderr);sys.exit(2)
child,master=pty.fork()
if child==0:
    os.execvpe(sys.argv[1],sys.argv[1:],os.environ)
fcntl.ioctl(master,termios.TIOCSWINSZ,struct.pack('HHHH',30,120,0,0))
closing=False
stdin_open=True
status=None

def stop(signum,frame):
    global closing
    closing=True
    try: os.killpg(child,signal.SIGTERM)
    except OSError: pass

signal.signal(signal.SIGTERM,stop)
signal.signal(signal.SIGINT,stop)
try:
    while True:
        if closing:
            time.sleep(.1)
            try: os.killpg(child,signal.SIGKILL)
            except OSError: pass
            break
        ready,_,_=select.select([master]+([0] if stdin_open else []),[],[],.1)
        if master in ready:
            try: data=os.read(master,65536)
            except OSError as e:
                if e.errno==errno.EIO: break
                raise
            if not data: break
            os.write(1,data)
        if 0 in ready:
            data=os.read(0,16384)
            if data: os.write(master,data)
            else:
                stdin_open=False
                os.write(master,b'\x04')
        pid,code=os.waitpid(child,os.WNOHANG)
        if pid:
            status=code
            while select.select([master],[],[],.05)[0]:
                try: data=os.read(master,65536)
                except OSError: break
                if not data: break
                os.write(1,data)
            break
finally:
    if status is None:
        try: os.killpg(child,signal.SIGTERM)
        except OSError: pass
    os.close(master)
    if status is None:
        try: _,status=os.waitpid(child,0)
        except ChildProcessError: status=0
sys.exit(128+os.WTERMSIG(status) if os.WIFSIGNALED(status) else os.WEXITSTATUS(status))
