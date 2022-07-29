from flask import Flask, render_template, request, jsonify
from flask_session import Session
from datetime import date
import os
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

#Generic Non-Route Functions
def add_log(msg, type):
    db.execute("INSERT INTO logs (description, type) VALUES (?, ?)", msg, type)

def get_log():
    logs = db.execute("SELECT * FROM logs WHERE DATE(date_created) == DATE('now')")
    formattedStr = ""
    for x in logs:
        formattedStr += f'{x["date_created"].split()[1]} | {x["type"]} | {x["description"]}\n'
    return formattedStr

def start_bot():
    global err_log
    args = ['python.exe', 'bot.py']
    err_log = open(os.path.join(os.path.dirname(__file__), "logs", "bot", f'BOT_{date.today().strftime("%d_%m_%Y")}.log'), 'a')   
    return Popen(args,
                 stderr=err_log,
                 start_new_session=True)

def kill_bot():
    try:       
        bot_pointer.kill()
        bot_pointer.wait()
        err_log.close()
    except:
        pass
        
def get_data(file_name):
    with open(os.path.join(os.path.dirname(__file__), "data", f"{file_name}.json"), "r") as fp:
        return json.load(fp)

def set_values(file_name, key, newval):
    values = get_data(file_name)
    values[key] = newval
    with open(os.path.join(os.path.dirname(__file__), "data", f"{file_name}.json"), "w") as fpw:
        json.dump(values, fpw)
    return

def set_file(file_name, json_data):
    with open(os.path.join(os.path.dirname(__file__), "data", f"{file_name}.json"), "w") as fpw:
        json.dump(json_data, fpw)
    return

def add_user_to_file(username):
    values = get_data("values")
    values["authUsers"].append(username)
    set_file("values", values)

def add_admin_to_file(admin):
    values = get_data("values")
    values["adminUsers"].append(admin)
    set_file("values", values)

def restart_bot():
    global bot_pointer
    j = get_data("statemachine")
    if j["botState"] == False:
        return
    kill_bot()
    bot_pointer = start_bot()
    set_values("statemachine", "botState", True)
    msg = "Restarting bot"
    add_log(msg, "IO")
    return msg

#Function called on exit, similar to shutdown
@atexit.register
def exit_shutdown():
    add_log("Shutting down webserver", "ATEXIT")
    kill_bot()
    set_values("statemachine", "botState", False)
    
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
    else:
        msg = f"The following key/values have been adjusted in {file_name}.json: {', '.join(dif)}"
        restart_bot()
    add_log(msg, "IO")   
    return msg
    
@app.route("/data", methods = ["POST"])
def return_data():
    return get_data(request.get_json()["document"])

@app.route("/on", methods = ["POST"])
def turn_bot_on():   
    global bot_pointer
    current_state = get_data("statemachine")
    current_values = get_data("values")
    if current_state["botState"]:
        msg = "Bot Is Already On"
        add_log(msg, "IO")
        return msg
    for x,y in current_values.items():
        if x == "internalReference": #Keys in values.json that the bot can start without
            pass
        if y == None or y == "":
            msg = "Missing Values"
            add_log(msg, "IO")
            return msg
    try:
        bot_pointer = start_bot()
    except:
        kill_bot()
    set_values("statemachine", "botState", True)
    msg = "Turning Bot On"
    add_log(msg, "IO")
    return msg

@app.route("/off", methods = ["POST"])
def turn_bot_off():
    if get_data("statemachine")["botState"] == False:
        msg = "Bot is already off"
        add_log(msg, "IO")
        return msg
    kill_bot()
    msg = "Turning Bot Off"
    set_values("statemachine", "botState", False)
    add_log(msg, "IO")
    return msg

@app.route("/shutdown", methods = ["POST"])
def shutdown():
    add_log("Shutting down webserver", "IO")
    kill_bot()
    set_values("statemachine", "botState", False)
    sig = getattr(signal, "SIGKILL", signal.SIGTERM)
    os.kill(os.getpid(), sig)

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
    restart_bot()
    return msg

@app.route("/enable", methods = ["POST"])
def enable_radson():
    req = request.get_json()
    msg = None
    for x,y in req.items():
        set_values("values", x, y)
        msg = f"{x} has been updated"
    add_log(msg, "IO")
    restart_bot()
    return msg

#Previously websocket route, changed to http for server framework
@app.route("/log", methods = ["GET", "POST"])
def check_log():
    return get_log()

#Running App Loop
if __name__ == "__main__":
    app.run(debug = False)

