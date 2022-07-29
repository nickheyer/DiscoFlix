#!/usr/bin/env python3.x
import discord
from typing import Any
import sys
from datetime import date
import os
from radarr_api_v3 import RadarrAPIv3 as RadarrAPI
from sonarr_api import SonarrAPI
from app import add_log, get_data, set_file
import asyncio

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
radarr_enabled : bool = bool(VALUES["radarrEnabled"])
sonarr_enabled : bool = bool(VALUES["sonarrEnabled"])

#Discord, Discord-Embed, Radarr, & Sonarr API Objects
client = discord.Client()
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

def return_google_link(title : str) -> str:
  return f"https://google.com/search?q={'+'.join(title.lower().split())}"

def get_log_dir() -> str: #Returns directory of log, within root. 
  return os.path.join(os.path.dirname(__file__), "logs", "bot", f'BOT_{date.today().strftime("%d_%m_%Y")}.log')

def create_debug_txt(txt : str) -> None:
  log_dir = os.path.join(os.path.dirname(__file__), "logs", "bot", f'BOT_debug.log')
  with open(log_dir, "w",  encoding="utf-8") as fp:
    fp.write(txt)

async def cycle_content(message : Any, request : str, content_list : list[Any], operator : str) -> str: #Returns TMDB-ID
    current_requester = message.author
    current_channel = message.channel.id
    number_of_results = len(content_list[:max_results])
    await add_msg(message, "Displaying results... \nType `stop` to cancel search, or `restart` to restart your search.") ; await asyncio.sleep(delay)
    while (True):
      for x in content_list[:max_results]: 
          try:
            embeded.set_image(url= x['remotePoster'])
            await message.channel.send(embed=embeded)
          except:
            embeded.set_image(url="https://i.imgur.com/1glpRCZ.png?1")
            await message.channel.send(embed=embeded)
          await add_msg(message, f"`{x['title']} | ({x['year']})`{' | ' + str(x['seasonCount']) + ' Seasons' if operator == 't' else ''}\n<{x['website'] if ('website' in x.keys() and x['website'] != '') else return_google_link(x['title'])}>\n```{x['overview']}```")
          await add_msg(message, "Is this correct? (`yes` or `no`)")
          try:
            await_choice = await client.wait_for('message', check=lambda message: (message.author == current_requester
            and message.channel.id == current_channel 
            and message.content.lower().strip() in ["yes", "y", "startover", "restart", "stop", "no", "n"])
            or (message.channel.id == current_channel 
            and str(message.author) in auth_users and message.content.lower().strip() in ["stop"]), timeout = 60)
          except asyncio.TimeoutError:
            await add_msg(message, f"{message.author.mention} has not responded within a 60-second period, session has ended.")
            return ""
          
          choice = await_choice.content.lower().strip()

          if choice in ["y", "yes"]:
            await add_msg(message, f"Selected: `{x['title']} ({x['year']})`") ; await asyncio.sleep(delay)
            if (operator == "m" and x["isAvailable"]):
              if x["hasFile"]:
                await add_msg(message, f"{request.title()} already accessible on {SERVER_NAME}, contact your server admin.")
                return ""
              return x["tmdbId"] if operator == "m" else x["tvdbId"]
            elif (operator == "t"):
              if "path" in x.keys():
                await add_msg(message, f"{request.title()} already accessible on {SERVER_NAME}, contact your server admin.")
            else:
              await add_msg(message, f"{request.title()} not currently available to request, contact your server admin.")
            return ""

          elif choice in ["startover", "restart"]:
            await add_msg(message, f"Starting search over...") ; await asyncio.sleep(delay)
            number_of_results = len(content_list)
            break

          elif choice in ["stop"]:
            await add_msg(message, f"Cancelling search... Have a good day!") ; await asyncio.sleep(delay)
            return ""

          elif choice in ["n", "no"]:
            number_of_results -= 1
            if number_of_results == 0:
              await add_msg(message, f"Unfortunately, we have run out of results.") ; await asyncio.sleep(delay)
              await add_msg(message, f"It's possible that this title does not exist, let's check if it does and try again...") ; await asyncio.sleep(delay)
              await add_msg(message, return_google_link(request))
              return ""
            else:
              pass

async def add_msg(incoming_msg : Any, outgoing_msg_str : str) -> None: #Adding a message response to the DB, uses add_log from app.py
  add_log(f"Generating Automated Response:\n>>{incoming_msg.author} : \"{incoming_msg.content}\"\n>>{client.user} : \"{outgoing_msg_str}\"", "BOT")
  await incoming_msg.channel.send(outgoing_msg_str)
  return

async def download_content(message: Any, id : str, operator : str) -> bool:
  try:
    if operator == "m":
      radarr.add_movie(id, 1)
    else:
      sonarr.add_series(id, 1)
  except:
    return False

async def find_content(message : Any, title : str, operator : str) -> None:
  content_type = {"m" : "movie", "t" : "show"}[operator]
  title = title.strip().lower()
  if title in ["", None]:
      return
  await add_msg(message, f"Searching for `{title.title()}`") ; await asyncio.sleep(delay)
  await add_msg(message, f"One moment...") ; await asyncio.sleep(delay)
  results = radarr.lookup_movie(title) if operator == "m" else sonarr.lookup_series(title)
  if results in ["", [], None]:
      await add_msg(message, f"Unfortunately, we can't find a {content_type} with a title matching the one you specified...") ; await asyncio.sleep(delay)
      await add_msg(message, f"It's possible that this {content_type} does not exist, let's check if it does and try again...") ; await asyncio.sleep(delay)
      await add_msg(message, return_google_link(title)) ; await asyncio.sleep(delay)
      return
  title_id = await cycle_content(message, title, results, operator)
  if title_id == "":
    return
  is_title_found = await download_content(message, title_id, operator)
  if (is_title_found != True):
    await add_msg(message, f"{content_type.title()} is being downloaded to {SERVER_NAME}.")
  else:
    await add_msg(message, f"Encountered an error, please contact server admin.")

async def add_user(message: Any, usr : str, operator : str) -> None:
  global auth_users, admin_users
  if usr in ["", None]:
    return
  j = get_data("values")
  if operator.lower() == "a":
    j["adminUsers"].append(usr)
    auth_users = j
    msg = f"{usr} has been added to list of admin users!"
  else:
    j["authUsers"].append(usr)
    admin_users = j
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

  elif message.content.startswith("test"):
    msg = f"Hello, world!"
    await add_msg(message, msg)
 
  else:
    return

if __name__ == "__main__":
  try:
    client.run(DISCORD_TOKEN)
  except Exception as e:
    add_log(f"Bot Encountered Error:{str(e)}\n\nPlease See Log For More Info >> {get_log_dir()}", "BOT")
    sys.exit()