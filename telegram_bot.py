from telebot import types as tbtypes
import telebot
from typing import Any
import sys
from datetime import date
import os
from radarr_api_v3 import RadarrAPIv3 as RadarrAPI
from sonarr_api import SonarrAPI
from app import add_log, get_data, set_file
from datetime import datetime

VALUES : dict[str : Any] = get_data("values")
TELEGRAM_TOKEN : str = VALUES["telegramToken"]
RADARR_TOKEN : str = VALUES["radarrToken"]
SONARR_TOKEN : str = VALUES["sonarrToken"]
SERVER_NAME : str = VALUES["mediaServerName"]
SONARR_URL : str = VALUES["sonarrHostUrl"]
RADARR_URL : str = VALUES["radarrHostUrl"]
prefix_keyword : str = VALUES["prefixKeyWord"]
auth_users : list[str] = VALUES["authUsers"]
admin_users : list[str] = VALUES["adminUsers"]
delay : int = int(VALUES["delay"])
max_results : int = int(VALUES["maxResults"])
max_check_time : int = int(VALUES["maxCheckTime"])
session_timeout : int = int(VALUES["sessionTimeout"])
max_seasons_nonadmin : int = int(VALUES["maxSeasonsNonadmin"])
radarr_enabled : bool = bool(VALUES["radarrEnabled"])
sonarr_enabled : bool = bool(VALUES["sonarrEnabled"])


#Telegram, Radarr, & Sonarr API Objects
client = telebot.TeleBot(TELEGRAM_TOKEN)
radarr = RadarrAPI(RADARR_URL, RADARR_TOKEN)
sonarr = SonarrAPI(SONARR_URL, SONARR_TOKEN)

#Generic Functions -------

def add_msg(incoming_msg : Any, outgoing_msg_str : str) -> None: #Adding a message response to the DB, uses add_log from app.py
  bot_type = "telegram"
  out = client.send_message(incoming_msg.json["chat"]["id"], outgoing_msg_str)
  add_log(f"Generating Automated Response [{bot_type.upper()}]:\n>>{incoming_msg.from_user.username} : \"{incoming_msg.text}\"\n>>{out.from_user.username} : \"{outgoing_msg_str}\"", "BOT")
  return

def parse_mode(msg : str) -> str:
  split_msg = msg.strip().split(prefix_keyword)[1].split()
  return split_msg[0]

def parse_request(msg : str, mode : str) -> str:
  split_msg = msg.strip().split()
  for x,y in enumerate(split_msg):
    if y in mode:
      return " ".join(split_msg[x+1:])
      
  return ""

def get_admins(message: Any) -> list[Any]:
  return admin_users

def return_google_link(title : str) -> str:
  return f"https://google.com/search?q={'+'.join(title.lower().split())}"

def get_log_dir() -> str: #Returns directory of log, within root. 
  return os.path.join(os.path.dirname(__file__), "logs", "bot", f'BOT_{date.today().strftime("%d_%m_%Y")}.log')

def create_debug_txt(txt : str) -> None:
  log_dir = os.path.join(os.path.dirname(__file__), "logs", "bot", f'BOT_debug.log')
  with open(log_dir, "w",  encoding="utf-8") as fp:
    fp.write(txt)

def recursive_cycle(message : Any, x : dict, operator : str, request : str, title : str, results : list[dict], iterator : int):
    if message.text.strip().lower() in ["yes", "y", "startover", "restart", "stop", "no", "n"]:
      choice = message.text.lower().strip()
    else:
      client.register_next_step_handler(message, recursive_cycle, x, operator, request, x['title'].title(), results, iterator)
      return

    if choice in ["y", "yes"]:
      add_msg(message, f"Selected: `{x['title']} ({x['year']})`")
      
      if (operator == "m"): #User is searching for Movie
        if x["hasFile"]:
          add_msg(message, f"{request.title()} already accessible on {SERVER_NAME}, contact your server admin.")
          return ""
        elif x["isAvailable"] == False or x["status"] in ["announced", "inCinemas"]:
          if x["monitored"]:
              add_msg(message, f"{SERVER_NAME} is already monitoring `{request.title()}`")
          add_msg(message, f"`{request.title()}` is likely not available to download yet, we will try now and monitor for a later release.")
          if 'inCinemas' in x.keys():
            release_date = datetime.strptime(x['inCinemas'].split('T')[0], '%Y-%m-%d')
            add_msg(message, f"`{request.title()}` {'came to' if x['status'] == 'inCinemas' else 'will be in'} theaters on:\n{release_date.strftime('`%m-%d-%Y`')}")
        title_id = x["tmdbId"]

      elif (operator == "t"): #User is searching for TV Show       
        if "path" in x.keys(): #If file path already exists on server, return nothing
          add_msg(message, f"{request.title()} already accessible on {SERVER_NAME}, contact your server admin.")
          return
        if (max_seasons_nonadmin == -1 #If the max seasons count is set to -1, meaning unlimited seasons OR
        or x['seasonCount'] < max_seasons_nonadmin): #The shows season count is less than the max seasons count
          
          title_id=x["tvdbId"]
        else:
          add_msg(message, f"{request.title()} not currently available to request, contact your server admin.")
          return

      if title_id == "":
        return
      title_found = download_content(title_id, operator)
      content_type = {"m" : "movie", "t" : "show"}[operator]
      if (title_found != None):
        add_msg(message, f"{content_type.title()} is being added to {SERVER_NAME}, please wait.")
      else:
        add_msg(message, f"Encountered an error while requesting {request.title()}, please contact server admin.")
      return

    elif choice in ["startover", "restart"]:
      add_msg(message, f"Starting search over...")
      cycle_content(message, title, results, operator, 0)
      return

    elif choice in ["stop"]:
      add_msg(message, f"Cancelling search... Have a good day!") 
      return 

    elif choice in ["n", "no"]:
      if iterator == len(results) - 1:
        add_msg(message, f"Unfortunately, we have run out of results.")
        add_msg(message, f"It's possible that this title does not exist, let's check if it does and try again...")
        add_msg(message, return_google_link(request))
        return ""
      else:
        cycle_content(message, title, results, operator, iterator + 1)
        return

def cycle_content(message : Any, request : str, content_list : list[Any], operator : str, iterator: int) -> Any: #Returns TMDB-ID
    x = content_list[iterator]
    msg = f"\t<b>{x['title']}</b>\n"
    markup = tbtypes.ReplyKeyboardMarkup(row_width=2, selective=True)
    itembtn1 = tbtypes.KeyboardButton('Yes')
    itembtn2 = tbtypes.KeyboardButton('No')
    itembtn3 = tbtypes.KeyboardButton('Restart')
    itembtn4 = tbtypes.KeyboardButton('Stop')
    markup.add(itembtn1, itembtn2, itembtn3, itembtn4)

    msg += f"""<pre>{('Seasons: ' + str(x['seasonCount']) + ' | ') if 'seasonCount' in x.keys() else ''}Year: {x['year']}</pre>
            <pre>{x['overview'] if 'overview' in x.keys() else '<i>No Description</i>'}</pre>\n\nLink:\n{x['website'] if ('website' in x.keys() and x['website'] != '') else return_google_link(x['title'])}\n\nIs this correct?"""
    try:
      client.send_photo(message.json["chat"]["id"], x['remotePoster'], caption=msg, reply_markup=markup, parse_mode="html")
    except:
      client.send_photo(message.json["chat"]["id"], "https://i.imgur.com/1glpRCZ.png?1", caption=msg, reply_markup=markup, parse_mode="html")
    try:
      client.register_next_step_handler(message, recursive_cycle, x, operator, request, x['title'].title(), content_list, iterator)
    except:
      add_msg(message, f"{message.author.mention} has not responded within a {session_timeout}-second period, session has ended.")
      return ""

def download_content(id : str, operator : str) -> Any:
  try:
    if operator == "m":
      response = radarr.add_movie(id, 1, rootDir=radarr.get_root()[0]['path'])
    else:
      response = sonarr.add_series(id, 1, rootDir=sonarr.get_root()[0]['path'], monitored=True, searchForMissingEpisodes=True)
    if 'message' in response.keys() and response['message'] == "The given path's format is not supported.":
      return None
    else:
      return response
  except:
    return None

def find_content(message : Any, title : str, operator : str) -> None:
  content_type = {"m" : "movie", "t" : "show"}[operator]
  title = title.strip().lower()
  if title in ["", None]:
      return
  add_msg(message, f"Searching for {title.title()}") 
  add_msg(message, f"One moment...")
  
  results = radarr.lookup_movie(title) if operator == "m" else sonarr.lookup_series(title)
  if max_results >= 0:
    if max_results < len(results):
      results = results[:max_results]

  if results in ["", [], None]:
      add_msg(message, f"Unfortunately, we can't find a {content_type} with a title matching the one you specified...")
      add_msg(message, f"It's possible that this {content_type} does not exist, let's check if it does and try again...")
      add_msg(message, return_google_link(title))
      return

  cycle_content(message, title, results, operator, 0)

def add_user(message: Any, usr : str, operator : str) -> None:
  global auth_users, admin_users
  if usr in ["", None]:
    return
  j = get_data("values")
  if operator.lower() == "a":
    if usr in j["adminUsers"]:
      msg = f"{usr} already in list of admin users!"
      add_msg(message, msg)
      return
    if usr not in j["authUsers"]:
      j["authUsers"].append(usr)
    j["adminUsers"].append(usr)
    auth_users = j
    msg = f"{usr} has been added to list of admin users!"
  else:
    if usr in j["authUsers"]:
      msg = f"{usr} already in list of authenticated users!"
      add_msg(message, msg)
      return
    j["authUsers"].append(usr)
    admin_users = j
    msg = f"{usr} has been added to list of authenticated users!"
  set_file("values", j)
  add_msg(message, msg)
  
def help_menu(message: Any) -> None:
  commands = [{"command" : "<b>movie</b>", "alternatives": ["m"], "usage" : f"{prefix_keyword} movie &lt;requested movie&gt;"},
              {"command" : "<b>tv-show</b>", "alternatives": ["tv", "show"], "usage" : f"{prefix_keyword} tv-show &lt;requested show&gt;"},
              {"command" : "<b>add-user</b>", "alternatives": ["user", "add"], "usage" : f"{prefix_keyword} add-user &lt;telegram username&gt;"},
              {"command" : "<b>add-admin</b>", "alternatives": ["admin", "op"], "usage" : f"{prefix_keyword} add-admin &lt;telegram username&gt;"},
              {"command" : "<b>help</b>", "alternatives": ["commands"], "usage" : f"{prefix_keyword} help"}]

  msg = "\n".join([f"<pre>Command : {x['command']}\nAlternatives : {', '.join(x['alternatives'])}\nUsage: \"{x['usage']}\"</pre>\n" for x in commands])
  client.send_message(message.json["chat"]["id"], msg, parse_mode="html")
  return
  
#Client events -------

@client.message_handler(commands=['start'])
def on_ready(message) -> None: #When bot starts up, adds log
  msg = f"Bot is logged in and listening for requests - '{prefix_keyword} help' for commands"
  add_log(msg, "BOT")
  add_msg(message, msg)
  return

@client.message_handler(func=lambda message: True)
def on_message(message) -> None: #On every incoming message, run the below code
  author = message.from_user.username
  if author not in auth_users: #If message sender is a non-user
    return 
  
  elif message.text.lower().startswith(prefix_keyword.lower()): #Message is sent with designated prefix, !df by default
    mode = parse_mode(message.text).lower()
    request = parse_request(message.text, mode).lower()

    if (radarr_enabled or author in admin_users) and mode in ["movie", "m"]:  
      find_content(message, request, "m") #Passes movie to finder function

    elif (sonarr_enabled or author in admin_users) and mode in ["tv", "tvshow", "show", "tv-show"]:
      find_content(message, request, "t") #Passes show to finder function  

    elif author in admin_users and mode in ["add-user", "user", "add"]: #Adds user to authenticated users
      add_user(message, parse_request(message.text, mode), "u")

    elif author in admin_users and mode in ["add-admin", "admin", "op"]: #Adds user to admin list
      add_user(message, parse_request(message.text, mode), "a")

    elif mode in ["help", "commands"]:
      help_menu(message)

  else:
    return


def main():
  add_log("Logged in with Telegram_bot", "BOT")
  client.infinity_polling(skip_pending=True)

if __name__ == "__main__":
  try:
    main()
  except Exception as e:
    add_log(f"Bot Encountered Error:{str(e)}\n\nPlease See Log For More Info >> {get_log_dir()}", "BOT")
    sys.exit()