import discord
from typing import Any
import sys
from datetime import date
import os
from radarr_api_v3 import RadarrAPIv3 as RadarrAPI
from sonarr_api import SonarrAPI
from app import add_log, get_data, set_file
import asyncio
from datetime import datetime

VALUES : dict[str : Any] = get_data("values")
DISCORD_TOKEN : str = VALUES["discordToken"]
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

#Declaring intents, must also be configured from Discord portal, see readme
intents = discord.Intents.all()

#Discord, Discord-Embed, Radarr, & Sonarr API Objects
client = discord.Client(intents = intents)
embeded = discord.Embed()
radarr = RadarrAPI(RADARR_URL, RADARR_TOKEN)
sonarr = SonarrAPI(SONARR_URL, SONARR_TOKEN)

#Generic Functions -------

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
  admin_list = list()

  for x in admin_users:
    try:
      admin = message.guild.get_member_named(x)
      if admin != None:
        admin_list.append(admin)
    except:
      pass
  
  return admin_list

def return_google_link(title : str) -> str:
  return f"https://google.com/search?q={'+'.join(title.lower().split())}"

def get_log_dir() -> str: #Returns directory of log, within root. 
  return os.path.join(os.path.dirname(__file__), "logs", "bot", f'BOT_{date.today().strftime("%d_%m_%Y")}.log')

def create_debug_txt(txt : str) -> None:
  log_dir = os.path.join(os.path.dirname(__file__), "logs", "bot", f'BOT_debug.log')
  with open(log_dir, "w",  encoding="utf-8") as fp:
    fp.write(txt)

async def cycle_content(message : Any, request : str, content_list : list[Any], operator : str) -> str: #Returns TMDB-ID
    global max_results
    current_requester = message.author
    current_channel = message.channel.id
    mr = max_results if max_results >= 0 else len(content_list)
    number_of_results = mr
    await add_msg(message, "Displaying results... \nType `stop` to cancel search, or `restart` to restart your search.") ; await asyncio.sleep(.5)
    while (True):
      for x in content_list[:mr]: 
          try:
            embeded.set_image(url= x['remotePoster'])
            await message.channel.send(embed=embeded)
          except:
            embeded.set_image(url="https://i.imgur.com/1glpRCZ.png?1")
            await message.channel.send(embed=embeded)
          await add_msg(message, f"`{x['title']} | ({x['year']}){(' | ' + str(x['seasonCount']) + ' Seasons`') if 'seasonCount' in x.keys() else '`'}\n<{x['website'] if ('website' in x.keys() and x['website'] != '') else return_google_link(x['title'])}>\n```{x['overview'] if 'overview' in x.keys() else 'No Description'}```"  + "\nIs this correct? (`yes` or `no`)")
          try:
            await_choice = await client.wait_for('message', check=lambda message: (message.author == current_requester
            and message.channel.id == current_channel 
            and message.content.lower().strip() in ["yes", "y", "startover", "restart", "stop", "no", "n"])
            or (message.channel.id == current_channel 
            and str(message.author) in auth_users and message.content.lower().strip() in ["stop"]), timeout = session_timeout)
          except asyncio.TimeoutError:
            await add_msg(message, f"{message.author.mention} has not responded within a {session_timeout}-second period, session has ended.")
            return ""
          
          choice = await_choice.content.lower().strip()

          if choice in ["y", "yes"]:
            await add_msg(message, f"Selected: `{x['title']} ({x['year']})`") ; await asyncio.sleep(delay)
            
            if (operator == "m"): #User is searching for Movie
              if x["hasFile"]:
                await add_msg(message, f"{request.title()} already accessible on {SERVER_NAME}, contact your server admin.")
                return ""
              elif x["isAvailable"] == False or x["status"] in ["announced", "inCinemas"]:
                if x["monitored"]:
                    await add_msg(message, f"{SERVER_NAME} is already monitoring `{request.title()}`") ; await asyncio.sleep(delay)
                await add_msg(message, f"`{request.title()}` is likely not available to download yet, we will try now and monitor for a later release.") ; await asyncio.sleep(delay)
                if 'inCinemas' in x.keys():
                  release_date = datetime.strptime(x['inCinemas'].split('T')[0], '%Y-%m-%d')
                  await add_msg(message, f"`{request.title()}` {'came to' if x['status'] == 'inCinemas' else 'will be in'} theaters on:\n{release_date.strftime('`%m-%d-%Y`')}")
                await asyncio.sleep(delay)
                return x["tmdbId"]
              else:
                return x["tmdbId"]
            
            elif (operator == "t"): #User is searching for TV Show       
              if "path" in x.keys(): #If file path already exists on server, return nothing
                await add_msg(message, f"{request.title()} already accessible on {SERVER_NAME}, contact your server admin.")
                return ""
              if (max_seasons_nonadmin == -1 #If the max seasons count is set to -1, meaning unlimited seasons OR
              or x['seasonCount'] <= max_seasons_nonadmin #The shows season count is less than the max seasons count OR
              or await admin_approval(message, f"Season count of {x['seasonCount']} is higher than limit of {max_seasons_nonadmin}")): #Requestor is admin or has admin approval
                return x["tvdbId"]
              else:
                return ""
            else:
              await add_msg(message, f"{request.title()} not currently available to request, contact your server admin.")
            return ""

          elif choice in ["startover", "restart"]:
            await add_msg(message, f"Starting search over...") ; await asyncio.sleep(delay)
            number_of_results = mr
            break

          elif choice in ["stop"]:
            await add_msg(message, f"Cancelling search... Have a good day!") 
            return ""

          elif choice in ["n", "no"]:
            number_of_results -= 1
            if number_of_results == 0:
              await add_msg(message, f"Unfortunately, we have run out of results.") ; await asyncio.sleep(delay)
              await add_msg(message, f"It's possible that this title does not exist, let's check if it does and try again...")
              await add_msg(message, return_google_link(request))
              return ""
            else:
              pass

async def add_msg(incoming_msg : Any, outgoing_msg_str : str) -> None: #Adding a message response to the DB, uses add_log from app.py
  bot_type = "discord"
  add_log(f"Generating Automated Response [{bot_type.upper()}]:\n>>{incoming_msg.author} : \"{incoming_msg.content}\"\n>>{client.user} : \"{outgoing_msg_str}\"", "BOT")
  await incoming_msg.channel.send(outgoing_msg_str)
  return

async def download_content(id : str, operator : str) -> Any:
  try:
    if operator == "m":
      response = radarr.add_movie(id, 1, radarr.get_root()[0]['path'])
    else:
      response = sonarr.add_series(id, 1, sonarr.get_root()[0]['path'], monitored=True, searchForMissingEpisodes=True)
    if type(response) == list and response[0].get('errorMessage', 'NO KEY') == 'This movie has already been added':
      add_log("Movie entry already exists in DB without file, deleting and re-adding", "Debug")
      movie_lookup = radarr.get_movie(id)[0]
      radarr.del_movie(movie_lookup['id'])
      return radarr.add_movie(id, 1, radarr.get_root()[0]['path'])
    elif response.get('message', 'NO KEY') == "The given path's format is not supported.":
      return None
    else:
      return response
  except Exception as e:
    add_log(str(e), "Debug")
    return None

async def find_content(message : Any, title : str, operator : str) -> None:
  content_type = {"m" : "movie", "t" : "show"}[operator]
  title = title.strip().lower()
  if title in ["", None]:
      return
  await add_msg(message, f"Searching for `{title.title()}`") ; await asyncio.sleep(delay)
  await add_msg(message, f"One moment...")
  results = radarr.lookup_movie(title) if operator == "m" else sonarr.lookup_series(title)
  if results in ["", [], None]:
      await add_msg(message, f"Unfortunately, we can't find a {content_type} with a title matching the one you specified...") ; await asyncio.sleep(delay)
      await add_msg(message, f"It's possible that this {content_type} does not exist, let's check if it does and try again...")
      await add_msg(message, return_google_link(title)) ; await asyncio.sleep(delay)
      return
  results = await cycle_content(message, title, results, operator)

  title_id = results
  if title_id in ["", None]:
    return
  title_found = await download_content(title_id, operator)
  if (title_found != None):
    await add_msg(message, f"{content_type.title()} is being added to {SERVER_NAME}, please wait.")
    if (operator == "m"):
      await monitor_download(message, title, title_found["id"])
  else:
    await add_msg(message, f"Encountered an error while requesting {title.title()}, please contact server admin.")

async def add_user(message: Any, usr : str, operator : str) -> None:
  global auth_users, admin_users
  if usr in ["", None]:
    return
  j = get_data("values")
  if operator.lower() == "a":
    if usr in j["adminUsers"]:
      msg = f"{usr} already in list of admin users!"
      await add_msg(message, msg)
      return
    if usr not in j["authUsers"]:
      j["authUsers"].append(usr)
    j["adminUsers"].append(usr)
    admin_users = j["adminUsers"]
    auth_users = j["authUsers"]
    msg = f"{usr} has been added to list of admin users!"
  else:
    if usr in j["authUsers"]:
      msg = f"{usr} already in list of authenticated users!"
      await add_msg(message, msg)
      return
    j["authUsers"].append(usr)
    auth_users = j["authUsers"]
    msg = f"{usr} has been added to list of authenticated users!"
  set_file("values", j)
  await add_msg(message, msg)
  
async def help_menu(message: Any) -> None:
  commands = [{"command" : "movie", "alternatives": ["m"], "usage" : f"{prefix_keyword} movie <requested movie>"},
              {"command" : "tv-show", "alternatives": ["tv", "show"], "usage" : f"{prefix_keyword} tv-show <requested show>"},
              {"command" : "add-user", "alternatives": ["user", "add"], "usage" : f"{prefix_keyword} add-user <discord username>"},
              {"command" : "add-admin", "alternatives": ["admin", "op"], "usage" : f"{prefix_keyword} add-admin <discord username>"},
              {"command" : "help", "alternatives": ["commands"], "usage" : f"{prefix_keyword} help"}]

  msg = "\n".join([f"```Command : {x['command']}\nAlternatives : {', '.join(x['alternatives'])}\nUsage: \"{x['usage']}\"```" for x in commands])
  await message.channel.send(msg)
  return

async def monitor_download(message: Any, title: str, id: int) -> None:
  seconds = 0
  interval_seconds = 10
  while (seconds < max_check_time):
    await asyncio.sleep(interval_seconds)
    history = radarr.get_history()['records']
    for x in history:
      if (x['movieId'] == id and x["eventType"] == "downloadFolderImported"):
        msg = f"`{title.title()}` has been added to `{SERVER_NAME}`."
        msg += f"\n{message.author.mention}"
        await add_msg(message, msg)
        return
    seconds += interval_seconds
  msg = f"`{SERVER_NAME}` was unable to find `{title.title()}`, continue checking {SERVER_NAME} for updates or contact your server admin."
  msg += f"\n{message.author.mention}"
  await add_msg(message, msg)
  return

async def admin_approval(message: Any, reason: str) -> bool:
  if (str(message.author) in admin_users):
    return True
  
  msg = f"Admin approval required for this action.\nReason: `{reason}`"
  await add_msg(message, msg) ; await asyncio.sleep(delay)
  admins = '\n'.join(map(lambda x: x.mention, get_admins(message)))
  msg = f"Contacting server admins:\n{admins}\nApproved? (`yes` or `no`)"
  await add_msg(message, msg)
  channel = message.channel.id
  try:
    await_choice = await client.wait_for('message', check=lambda m: (
    m.channel.id == channel
    and m.content.lower().strip() in ["yes", "y", "no", "n"]
    and str(m.author) in admin_users), timeout = session_timeout)
  except asyncio.TimeoutError:
    await add_msg(message, f"Admin has not responded within a {session_timeout}-second period, session has ended.")
    return False
  if await_choice.content.lower().strip() in ["y", "yes"]:
    await add_msg(message, f"Approved by admin.")
    return True
  else:
    await add_msg(message, f"Denied by admin.")
    return False
  
#Client events -------

@client.event
async def on_ready() -> None: #When bot starts up, adds log
  discord_activity = f"{prefix_keyword} help" #Displays bot's activity as "Listening to !df help" - replace !df with PFKW 
  await client.change_presence(activity=discord.Activity(type = discord.ActivityType.listening, name = discord_activity)) 
  add_log(f"Logged In As {client.user}", "BOT")
  return

@client.event
async def on_message(message) -> None: #On every incoming message, run the below code
  author = str(message.author)
  if message.author == client.user or author not in auth_users: #If message sender is another bot, or itself, or a non-user
    return 
  elif message.content.lower().startswith(prefix_keyword.lower()): #Message is sent with designated prefix, !df by default
    mode = parse_mode(message.content).lower()
    request = parse_request(message.content, mode).lower()
    if (radarr_enabled or author in admin_users) and mode in ["movie", "m"]:  
      await find_content(message, request, "m") #Passes movie to finder function
    elif (sonarr_enabled or author in admin_users) and mode in ["tv", "tvshow", "show", "tv-show"]:
      await find_content(message, request, "t") #Passes show to finder function  
    elif author in admin_users and mode in ["add-user", "user", "add"]: #Adds user to authenticated users
      await add_user(message, parse_request(message.content, mode), "u")
    elif author in admin_users and mode in ["add-admin", "admin", "op"]: #Adds user to admin list
      await add_user(message, parse_request(message.content, mode), "a")
    elif mode in ["help", "commands"]:
      await help_menu(message)
  else:
    return

if __name__ == "__main__":
  try:
    client.run(DISCORD_TOKEN)
  except Exception as e:
    add_log(f"Bot Encountered Error:{str(e)}\n\nPlease See Log For More Info >> {get_log_dir()}", "BOT")
    sys.exit()