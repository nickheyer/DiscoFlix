import os
import gevent
from sys import platform
import subprocess
from subprocess import Popen

from lib.utils import get_venv_python_dict

from models.models import ErrLog

# Global subproc
bot_procs = {}


def start_bot(name, host, token):
    if bot_procs.get(name, None):
        raise Exception(f"{name.title()}-bot already on")
    op_call = None
    venv = get_venv_python_dict()
    if venv and os.path.exists(venv):
        op_call = os.path.join(venv, "bin", "python")
    elif platform in ["linux", "linux2", "darwin"]:
        op_call = "python3"
    elif platform == "win32":
        op_call = "python.exe"
    args = [op_call, f"bot/{name}_bot.py", "--host", host, "--token", token]
    err_log = ErrLog(entry="")
    bot_procs[name] = Popen(args, stderr=subprocess.PIPE, start_new_session=True)
    err_log.entry = bot_procs[name].stderr.read().decode("utf-8")
    err_log.save()
    bot_procs[name].wait()
    bot_procs[name].communicate()
    bot_procs[name] = None


def kill_bot(name):
    bot_proc = bot_procs.get(name, None)
    if not bot_proc:
        raise Exception(f"{name.title()}-bot already off")
    try:
        bot_proc.terminate()
    except Exception as e:
        print("EXCEPTION: ", e)
        pass


def kill_all_bots():
    for k, v in bot_procs.items():
        if v:
            try:
                v.terminate()
                v.wait()
                v.communicate()
            except:
                pass
