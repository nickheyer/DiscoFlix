import discord
from urllib.request import Request, urlopen
from time import sleep
import json
import os
import io
from radarr_api_v3 import RadarrAPIv3
from sonarr_api import SonarrAPI
from datetime import date
import sys
import asyncio

#First time setup procedure
print("Welcome to DiscoFlix")
INI_PATH = os.path.join(os.path.dirname(__file__), f'ini_values.json')
try:
  with open(INI_PATH, "r") as ini_values:
    startup_val = json.load(ini_values)
except:
  print("If at anytime during the following requests you enter in the wrong value by mistake, simply close DiscoFlix.py, delete the file 'ini_values.json' and try again!") ; sleep(1)
  startup_val = {}
  startup_val["disc_token"] = input("Please enter your Discord API token here: ") ; sleep(1)
  startup_val["rad_token"] = input("Please enter your Radarr API token here: ") ; sleep(1)
  startup_val["rad_host"] = input("Please enter your Radarr's Host Url (include port number as well): ") ; sleep(1)
  startup_val["enable_son"] = input("Would you like to enable TV-Show requests with Sonarr? ('yes' or 'no') ")
  if startup_val["enable_son"].lower().strip() == "yes":
    startup_val["son_token"] = input("Please enter your Sonarr API token here: ") ; sleep(1)
    startup_val["son_host"] = input("Please enter your Sonarr's Host Url (include port number as well): ") ; sleep(1) 
  startup_val["tmdb_token"] = input("Please enter your TMDB API token here: ") ; sleep(1)
  startup_val["s_name"] = input("Please enter the name of your media server here: ") ; sleep(1)
  startup_val["s_host"] = input("Please enter your discord username here (with discord id number at the end, ex: NastyNick#4212): ") ; sleep(1)
  startup_val["avg_d_time"] = input("Please enter the average time it takes (in minutes) for your server to find, download, and unpack a movie here (using quality profile 'any'): ") ; sleep(1)
  with open(INI_PATH, "w") as ini_values:
    json.dump(startup_val, ini_values)

#Discord API Token
TOKEN = startup_val["disc_token"]
#Radarr API Token
R_TOKEN = startup_val["rad_token"]
#Radarr Host Url
R_HOST_URL = startup_val["rad_host"]
#Radarr API Var
radarr = RadarrAPIv3(R_HOST_URL, R_TOKEN)
#Radarr API Token
S_TOKEN = startup_val["son_token"]
#Sonarr Host Url
S_HOST_URL = startup_val["son_host"]
#Sonarr API Var
sonarr = SonarrAPI(S_HOST_URL, S_TOKEN)
#TMDB API Token
TMDB_TOKEN = startup_val["tmdb_token"]
#Request command
keyword = "!df"
#Last search json file
last_search = os.path.join(os.path.dirname(__file__), f'last_search.json')
#Set your server name to be referenced in message responses
SERVER_NAME = startup_val["s_name"]
#Set your discord name to be referenced in message responses
ADMIN_NAME = startup_val["s_host"]
#Set your avg download time per movie - in seconds
avg_time_download = int(startup_val["avg_d_time"])
avg_time_seconds = avg_time_download * 60

#Attempting to read auth. user list
AUTH_USER_PATH = os.path.join(os.path.dirname(__file__), f'auth_users.json')
try:
  with open(AUTH_USER_PATH, "r") as auth_user_json:
    auth_users = json.load(auth_user_json)
except:
  auth_users = {}
  auth_users["1"] = ADMIN_NAME
  with open(AUTH_USER_PATH, "w") as auth_user_json:
    json.dump(auth_users, auth_user_json)



client = discord.Client()
embed = discord.Embed()


@client.event
async def on_ready():
  disc_act = "!df help"
  await client.change_presence(activity=discord.Activity(type = discord.ActivityType.listening, name = disc_act))
  print("Bot is ready to party, logged in as {0.user}.".format(client))

@client.event
async def on_message(message):
  global keyword
  full_user = (f"{message.author.name}#{message.author.discriminator}")
  current_requester = message.author
  current_channel = message.channel.id
  player_choice = None
  if message.author == client.user:
    return
  elif message.content.lower().startswith(f"{keyword.lower()} movie") and full_user in auth_users.values():
    req_movie = message.content.lower()[(len(keyword) + 6):].strip()
    str_req_movie = req_movie.title()
    await message.channel.send(f"Searching for {req_movie.title()}")
    await asyncio.sleep(1)
    await message.channel.send(f"One moment...")
    await asyncio.sleep(1)
    req_movie_rep = ""
    for x in req_movie:
        if x == " ":
          req_movie_rep += "%"
        elif x.isalpha() == False and x.isdigit() == False:
          pass
        else:
          req_movie_rep += x
    google_search_req = ""
    for x in req_movie_rep:
      if x == "%":
        google_search_req += "+"
      else:
        google_search_req += x
    req_movie = req_movie_rep
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 6.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/41.0.2228.0 Safari/537.3"}
    req = Request(url=f"https://api.themoviedb.org/3/search/movie?api_key={TMDB_TOKEN}&query={req_movie}", headers=headers) 
    html = urlopen(req)
    html = json.load(html)
    if html == {"page":1,"results":[],"total_pages":0,"total_results":0}:
      if "%" in req_movie:
        req_movie_rep = ""
        for x in req_movie:
          if x == "%":
            req_movie_rep += "-"
          else:
            req_movie_rep += x
        req_movie = req_movie_rep
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 6.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/41.0.2228.0 Safari/537.3"}
        req = Request(url=f"https://api.themoviedb.org/3/search/movie?api_key={TMDB_TOKEN}&query={req_movie}", headers=headers) 
        html = urlopen(req)
        html = json.load(html)
        if html == {"page":1,"results":[],"total_pages":0,"total_results":0}:
          await message.channel.send(f"No results found for '{str_req_movie}'")
          await asyncio.sleep(1)
          await message.channel.send(f"Let's try searching the internet for it...")
          await asyncio.sleep(1)
          await message.channel.send(f"https://letmegooglethat.com/?q={google_search_req}%3F")
          return 
      else:
        await message.channel.send(f"No results found for '{str_req_movie}'")
        await asyncio.sleep(1)
        await message.channel.send(f"Let's try searching the internet for it...")
        await asyncio.sleep(1)
        await message.channel.send(f"https://letmegooglethat.com/?q={google_search_req}%3F")
        return 
    print_list = {}
    for x in html["results"]:
        x["release_date"] = x.get("release_date", "Release date unavailable")
        x["title"] = x.get("title", "Title unavailable")
        poster_suffix = x.get("poster_path", "/dykOcAqI01Fci5cKQW3bEUrPWwU.jpg")
        x["poster_path"] = (f"https://image.tmdb.org/t/p/original{poster_suffix}")
        x["overview"] = x.get("overview", "Description unavailable.")
        # x["id"] = x.get("id", )
        if x["overview"] == "":
          x["overview"] = "Description unavailable."
        if "jpg" not in x["poster_path"]:
          x["poster_path"] = "https://i.imgur.com/1glpRCZ.png?1"
        print_list[x["original_title"]] = [x["id"], x["poster_path"], x["title"], x["release_date"], x["overview"]]
    with io.open(last_search, "w", encoding = "UTF-8") as last_search_w:
        json.dump(print_list, last_search_w)
    with io.open(last_search, "r", encoding = "UTF-8") as last_search_r:
        list_of_movies = json.load(last_search_r)
    selected_movie_id = ""
    selected_movie = ""
    number_of_results = len(list_of_movies.keys())
    count_1 = 0
    await message.channel.send(f"Displaying results... \nType 'stop' to cancel search, or 'startover' to restart your search.")
    await asyncio.sleep(1)
    while True:
      for x,y in list_of_movies.items():
          await message.channel.send("Is this the correct movie? ('yes' or 'no')")
          await asyncio.sleep(1)
          embed.set_image(url= y[1])
          await message.channel.send(embed=embed)
          await message.channel.send(f"`{y[2]} ({y[3]})`\n```{y[4]}```")
          player_choice = await client.wait_for('message', check=lambda message: message.author == current_requester and message.channel.id == current_channel and message.content.lower().strip() in ["yes", "y", "startover", "stop", "no", "n", ])
          if player_choice.content.lower().strip() == "yes" or player_choice.content.lower().strip() == "y":
            selected_movie = (f"{y[2]} ({y[3]})")
            await message.channel.send(f"Selected: `{selected_movie}`")
            await asyncio.sleep(2)
            selected_movie_id = y[0]
            break
          elif player_choice.content.lower().strip() == "startover":
            await message.channel.send(f"Starting search over...")
            await asyncio.sleep(1)
            break
          elif player_choice.content.lower().strip() == "stop":
            await message.channel.send(f"Cancelling search... Have a good day!")
            await asyncio.sleep(1)
            return
          elif player_choice.content.lower().strip() == "no" or player_choice.content.lower().strip() == "n":
            count_1 += 1
            if count_1 == number_of_results:
              await message.channel.send(f"Unfortunately, we have run out of results.")
              await asyncio.sleep(1)
              await message.channel.send(f"It's possible that this movie does not exist, let's check if it does and try again...")
              await asyncio.sleep(1)
              await message.channel.send(f"https://letmegooglethat.com/?q={google_search_req}%3F")
              return
            else:
              pass
      if player_choice.content.lower().strip() == "yes" or player_choice.content.lower().strip() == "y":
        break
      elif player_choice.content.lower().strip() == "startover":
        pass
    #Storing of dl logs
    LOGS_PATH = os.path.join(os.path.dirname(__file__), f'LOGS\\{date.today()}.txt')
    og_stdout = sys.stdout
    try:  
      with io.open(LOGS_PATH, "a", encoding = "UTF-8") as logs_file:
        sys.stdout = logs_file
        print(f"{message.author.name}#{message.author.discriminator} requested:\n")
        add_movie = radarr.add_movie(selected_movie_id, 1)
        sys.stdout = og_stdout
    except:
      with io.open(LOGS_PATH, "w", encoding = "UTF-8") as logs_file:
        sys.stdout = logs_file
        print(f"{message.author.name}#{message.author.discriminator} requested:\n")
        add_movie = radarr.add_movie(selected_movie_id, 1)
        sys.stdout = og_stdout
    if str(type(add_movie)) == "<class 'list'>":
        await message.channel.send(f"Looks like this movie is already available on {SERVER_NAME}, if not, please contact {ADMIN_NAME}.")
        return
    else:
        await message.channel.send(f"Movie is being downloaded to {SERVER_NAME}.")
        await asyncio.sleep(1)
        await message.channel.send(f"Please wait: {avg_time_download} minute(s)...")
        await asyncio.sleep(avg_time_seconds)
        movie_check = radarr.get_movie(selected_movie_id)
        try:
          radarr_id = movie_check[0]["movieFile"]['id']
          if radarr.get_movie_file(radarr_id) == {'message': 'NotFound'}:
            await message.channel.send(f"{SERVER_NAME} is having trouble finding `{selected_movie}`, please check server frequently for updates as this may be added at a later time.")
          else:
            await message.channel.send(f"`{selected_movie}` is now available on {SERVER_NAME}. Enjoy!")
        except:
          await message.channel.send(f"{SERVER_NAME} is having trouble finding `{selected_movie}`, please check server frequently for updates as this may be added at a later time.")
  elif message.content.lower().startswith(f"{keyword.lower()} tvshow") and full_user in auth_users.values() and startup_val["enable_son"].lower().strip() == "yes":
    req_show = message.content.lower()[(len(keyword) + 7):].strip()
    str_req_show = req_show.title()
    google_search_req = ""
    for x in req_show:
      if x == " ":
        google_search_req += "+"
      else:
        google_search_req += x      
    await message.channel.send(f"Searching for {req_show.title()}")
    await asyncio.sleep(1)
    await message.channel.send(f"One moment...")
    await asyncio.sleep(1)
    show_search = (sonarr.lookup_series(f"'{req_show}'"))[:10]
    count_1 = 0
    if show_search == []:
      await message.channel.send(f"Unfortunately, we can't find a show with a title matching the one you specified..")
      await asyncio.sleep(1)
      await message.channel.send(f"It's possible that this show does not exist, let's check if it does and try again...")
      await asyncio.sleep(1)
      await message.channel.send(f"https://letmegooglethat.com/?q={google_search_req}%3F")
      return    
    while True:
      for x in show_search: 
          await message.channel.send("Is this the correct show? ('yes' or 'no')")
          await asyncio.sleep(1)
          try:
            embed.set_image(url= x["images"][1]["url"])
          except:
            embed.set_image(url="https://i.imgur.com/1glpRCZ.png?1")
          await message.channel.send(embed=embed)
          await message.channel.send(f"`{x['title']} ({x['year']})`\n```{x['overview']}```")
          player_choice = await client.wait_for('message', check=lambda message: message.author == current_requester and message.channel.id == current_channel and message.content.lower().strip() in ["yes", "y", "startover", "stop", "no", "n", ])
          if player_choice.content.lower().strip() == "yes" or player_choice.content.lower().strip() == "y":
            await message.channel.send(f"Selected: `{x['title']} ({x['year']})`")
            await asyncio.sleep(2)
            selected_show_title = x['title']
            selected_show_id = x['tvdbId']
            break
          elif player_choice.content.lower().strip() == "startover":
            await message.channel.send(f"Starting search over...")
            await asyncio.sleep(1)
            break
          elif player_choice.content.lower().strip() == "stop":
            await message.channel.send(f"Cancelling search... Have a good day!")
            await asyncio.sleep(1)
            return
          elif player_choice.content.lower().strip() == "no" or player_choice.content.lower().strip() == "n":
            count_1 += 1
            if count_1 == len(show_search):
              await message.channel.send(f"Unfortunately, we have run out of results.")
              await asyncio.sleep(1)
              await message.channel.send(f"It's possible that this show does not exist, let's check if it does and try again...")
              await asyncio.sleep(1)
              await message.channel.send(f"https://letmegooglethat.com/?q={google_search_req}%3F")
              return
            else:
              pass
      if player_choice.content.lower().strip() == "yes" or player_choice.content.lower().strip() == "y":
        break
      elif player_choice.content.lower().strip() == "startover":
        pass
    #Getting rootdir path
    rootdir = sonarr.get_root()[0]['path']
    #Storing of dl logs
    LOGS_PATH = os.path.join(os.path.dirname(__file__), f'LOGS\\{date.today()}.txt')
    og_stdout = sys.stdout
    try:  
      with io.open(LOGS_PATH, "a", encoding = "UTF-8") as logs_file:
        sys.stdout = logs_file
        print(f"{message.author.name}#{message.author.discriminator} requested:\n")
        add_show = sonarr.add_series(selected_show_id, 1, rootdir)
        print(sonarr.lookup_series(selected_show_id))
        sys.stdout = og_stdout
    except:
      with io.open(LOGS_PATH, "w", encoding = "UTF-8") as logs_file:
        sys.stdout = logs_file
        print(f"{message.author.name}#{message.author.discriminator} requested:\n")
        add_show = sonarr.add_series(selected_show_id, 1, rootdir)
        print(sonarr.lookup_series(selected_show_id))
        sys.stdout = og_stdout
    if str(type(add_show)) == "<class 'list'>":
        await message.channel.send(f"Looks like this show is already available on {SERVER_NAME}, if not, please contact {ADMIN_NAME}.")
    else:
        await message.channel.send(f"Show is being downloaded to {SERVER_NAME}.")
        await asyncio.sleep(1)
        await message.channel.send(f"Please wait while the show is being downloaded, check server frequently.")
        s_id = 0
        for x in sonarr.get_series():
          if x['title'] == selected_show_title:
                s_id = x['id']
        sonarr.set_command(name = "missingEpisodeSearch", seriesId = s_id)
  elif message.content.startswith("!df set keyword") and full_user in auth_users.values():
    keyword = message.content.strip()[13:]
    await message.channel.send(f"You can now request movies and tv-shows with '{keyword}'.")
  elif message.content.lower().startswith("!df add user") and full_user in auth_users.values():
    added_user = message.content.strip()[12:]
    count = 1
    for x in auth_users.keys():
      count += 1
    auth_users[str(count)] = added_user.strip()
    await asyncio.sleep(1)
    await message.channel.send(f"{added_user.strip()} has been added to authorized users!")
    with open(AUTH_USER_PATH, "w") as auth_user_json:
      json.dump(auth_users, auth_user_json)
  elif message.content.lower().startswith("!df help") and full_user in auth_users.values():
        await message.channel.send(f"'{keyword} movie'\n'{keyword} tvshow'\n'!df set keyword <new keyword>'\n'!df add user <user>'\n\n'For more help, visit https://github.com/nickheyer/DiscoFlix'")
  else:
    return

client.run(TOKEN)