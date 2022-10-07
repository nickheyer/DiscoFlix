from flask import Flask, render_template, request, jsonify
from flask_session import Session
from datetime import date
import os
from sys import platform
import sys
from cs50 import SQL
from subprocess import Popen
import atexit
import signal
import json


app = Flask(__name__)

#Primary Database
db = SQL("sqlite:///discodb.db")

# Ensure templates are auto-reloaded
app.config["TEMPLATES_AUTO_RELOAD"] = True

# Configure session to use filesystem (instead of signed cookies)
app.config["SESSION_PERMANENT"] = False
app.config["SESSION_TYPE"] = "filesystem"
app.config['SOCK_SERVER_OPTIONS'] = {'ping_interval': 45}

#Creating Session
Session(app)

#Subprocesses List
sub_proc = list()

#Generic Non-Route Functions
def add_log(msg, type):
    db.execute("INSERT INTO logs (description, type) VALUES (?, ?)", msg, type)

def get_log():
    logs = db.execute("SELECT * FROM logs WHERE DATE(date_created) == DATE('now')")
    formattedStr = ""
    for x in logs:
        formattedStr += f'{x["date_created"].split()[1]} | {x["type"]} | {x["description"]}\n'
    return formattedStr

def start_bot(bot_type):
    op_call = None
    if platform in ["linux", "linux2", "darwin"]:
        op_call = "python3"
    elif platform == "win32":
        op_call = "python.exe"
    args = [op_call, f'{bot_type}_bot.py']
    err_log = open(os.path.join(os.path.dirname(__file__), "logs", "bot", f'{bot_type.upper()}BOT_{date.today().strftime("%d_%m_%Y")}.log'), 'a')   
    sub_proc.append({"bot_type": bot_type, "process": Popen(args, stderr=err_log, start_new_session=True), "error_log": err_log})
    set_values("statemachine", f"{bot_type}_botState", True)

def kill_bot(bot_type):
    global sub_proc
    if len(sub_proc) == 0:
        set_values("statemachine", f"{bot_type}_botState", False)
        return
    tmp_proc = list()
    for x in sub_proc:
        if x["bot_type"] == bot_type:
            try:       
                x["process"].kill()
                x["process"].wait()
                x["error_log"].close()
                set_values("statemachine", f"{bot_type}_botState", False)
            except Exception as e:
                add_log(f"Error while shutting down {bot_type} : {e}.", "IO")
                pass
        else:
            tmp_proc.append(x)
    sub_proc = tmp_proc

def kill_all_bots():
    global sub_proc
    j = get_data("statemachine")
    try:
        for x in sub_proc:               
            x["process"].kill()
            x["process"].wait()
            x["error_log"].close()
            j[f'{x["bot_type"]}_botState'] = False
        sub_proc = list()
        set_file("statemachine", j)
    except Exception as e:
        add_log(f"Error while shutting down all bots : {e}.", "IO")
        pass

def get_misc_text(file_name):
    dir = os.path.join(os.path.dirname(__file__), "static", "misc")
    if not os.path.exists(dir):
        os.mkdir(dir)
    with open(os.path.join(dir, f"{file_name}.txt"), "r") as fp:
        txt = fp.read()
        print(txt)
        return txt

def get_data(file_name):
    with open(os.path.join(os.path.dirname(__file__), "data", f"{file_name}.json"), "r") as fp:
        return json.load(fp)

def set_values(file_name, key, newval):
    values = get_data(file_name)
    values[key] = newval
    with open(os.path.join(os.path.dirname(__file__), "data", f"{file_name}.json"), "w") as fpw:
        json.dump(values, fpw)

def set_file(file_name, json_data):
    with open(os.path.join(os.path.dirname(__file__), "data", f"{file_name}.json"), "w") as fpw:
        json.dump(json_data, fpw)

def add_user_to_file(username):
    values = get_data("values")
    if "," in username:
        list_of_users = username.split(",")
        for user in list_of_users:
            values["authUsers"].append(user.strip())
    else:
        values["authUsers"].append(username.strip())   
    set_file("values", values)

def add_admin_to_file(admin):
    values = get_data("values")
    if "," in admin:
        list_of_admins = admin.splits(",")
        for a in list_of_admins:
            if a.strip() not in values["authUsers"]:
                values["authUsers"].append(a.strip())
            values["adminUsers"].append(a.strip())
    else:
        if admin not in values["authUsers"]:
            values["authUsers"].append(admin.strip())
        values["adminUsers"].append(admin.strip())
    set_file("values", values)

def restart_all_bots():
    if len(sub_proc) != 0:
        for x in sub_proc:
            restart_bot(x["bot_type"])
        add_log(f"Restarting all currently running bots.", "IO")
    else:
        return

def restart_bot(bot_type):
    bot = bot_type
    kill_bot(bot)
    start_bot(bot)
    


@app.before_first_request #auto-starting based on current state stored in statemachine.json
def startup():
    current_status = get_data("statemachine")
    for key, val in current_status.items():
        if key.endswith("_botState"):
            if val == False:
                continue
            else:
                bot_type = key[:-len("_botState")]
                start_bot(bot_type=bot_type)


#Function called on exit, similar to shutdown
@atexit.register
def exit_shutdown():
    add_log("Shutting down webserver", "ATEXIT")
    kill_all_bots()
    
#Beginning Routes with default index temp func
@app.route("/")
def index():
    data_list = [get_data("statemachine"), get_data("values")]
    return render_template("/index.html",
    data_list = data_list,
    state = data_list[0],
    values = data_list[1])

#Autocomplete route for user lookup, for admin input in form
@app.route("/autoadmin")
def auto_admin():
    form_input  = request.args["q"]
    values_json = get_data("values")
    current_users = values_json["authUsers"]
    return jsonify([x for x in current_users if form_input in x])

@app.route("/save", methods = ["POST"])
def save_credentials():
    req = request.get_json()
    file_name = req["file"]
    json_data = req["data"]
    prev = get_data(file_name)
    dif = list()
    for x in prev:
        if prev[x] != json_data[x]:
            dif.append(x)
    set_file(file_name, json_data)
    if len(dif) == 0:
        msg = f"No values have been changed in {file_name}.json"
        add_log(msg, "IO")  
    else:
        restart_all_bots()
        msg = f"The following values have been modified: {', '.join(dif)}"
        add_log(msg, "IO")
    return msg
    
@app.route("/data", methods = ["POST"])
def return_data():
    return get_data(request.get_json()["document"])

@app.route("/on", methods = ["POST"])
def turn_bot_on():
    current_state = get_data("statemachine")
    current_values = get_data("values")
    req_op = request.get_json()["type"]
    if current_state[f"{req_op}_botState"]:
        msg = f"{req_op.title()} Bot Is Already On"
        add_log(msg, "IO")
        return msg
    for x,y in current_values.items():
        if x == "internalReference" or ("Token" in x and req_op not in x): #Keys in values.json that the bot can start without
            pass
        elif y == None or y == "":
            msg = "Missing Values"
            add_log(msg, "IO")
            return msg
    try:
        start_bot(req_op)
    except:
        kill_bot(req_op)
    msg = f"Turning {req_op.title()} Bot On"
    add_log(msg, "IO")
    return msg

@app.route("/off", methods = ["POST"])
def turn_bot_off():
    req_op = request.get_json()["type"]
    if get_data("statemachine")[f"{req_op}_botState"] == False:
        msg = "Bot is already off"
        add_log(msg, "IO")
        return msg
    kill_bot(req_op)
    msg = f"Turning {req_op.title()} Bot Off"
    add_log(msg, "IO")
    return msg

@app.route("/shutdown", methods = ["POST"])
def shutdown():
    add_log("Shutting down webserver", "IO")
    kill_all_bots()
    if sys.platform in ["linux", "linux2"]:
        os.system("pkill -f gunicorn")
    elif sys.platform == "win32":
        sig = getattr(signal, "SIGKILL", signal.SIGTERM)
        os.kill(os.getpid(), sig)
    return "Shutting Down"

@app.route("/adduser", methods = ["POST"])
def add_user():
    req = request.get_json()
    if "user" in req and req["user"] not in ["", None]:
        user = req["user"]
        add_user_to_file(user)
        msg = f"{user} added to authenticated users"
    elif "admin" in req and req["admin"] not in ["", None]:
        admin = req["admin"]
        add_admin_to_file(admin)
        msg = f"{admin} added to admin users"
    else:
        msg = "No users/admins added"
    add_log(msg, "IO")
    restart_all_bots()
    return msg

@app.route("/enable", methods = ["POST"])
def enable_radson():
    req = request.get_json()
    msg = None
    for x,y in req.items():
        set_values("values", x, y)
        msg = f"{x} has been updated"
        add_log(msg, "IO")
    restart_all_bots()
    return msg

#Previously websocket route, changed to http for server framework
@app.route("/log", methods = ["GET", "POST"])
def check_log():
    return get_log()

#Running App Loop
if __name__ == "__main__":
    app.run(debug = False)

