import discord
from urllib.request import Request, urlopen
from time import sleep
import json
import os
import io
from radarr_api_v3 import RadarrAPIv3
from datetime import date
import sys

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
  startup_val["tmdb_token"] = input("Please enter your TMDB API token here: ") ; sleep(1)
  startup_val["s_name"] = input("Please enter the name of your media server here: ") ; sleep(1)
  startup_val["s_host"] = input("Please enter your discord username here (with discord id number at the end, ex: NastyNick#4212): ") ; sleep(1)
  startup_val["avg_d_time"] = input("Please enter the average time it takes (in seconds) for a movie to download (using quality preset 'any') here: ") ; sleep(1)
  with open(INI_PATH, "w") as ini_values:
    json.dump(startup_val, ini_values)

#Discord API Token
TOKEN = startup_val["disc_token"]
#Radarr API Token
R_TOKEN = startup_val["rad_token"]
#Radarr Host Url
HOST_URL = startup_val["rad_host"]
#Radarr API Var
radarr = RadarrAPIv3(HOST_URL, R_TOKEN)
#TMDB API Token
TMDB_TOKEN = startup_val["tmdb_token"]
#Movie request command
keyword = "!df request"
#Last search json file
last_movies = os.path.join(os.path.dirname(__file__), f'last_movies.json')
#Set your server name to be referenced in message responses
SERVER_NAME = startup_val["s_name"]
#Set your discord name to be referenced in message responses
ADMIN_NAME = startup_val["s_host"]
#Set your avg download time per movie - in seconds
avg_time_download = int(startup_val["avg_d_time"])

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


#Storing of dl logs
LOGS_PATH = os.path.join(os.path.dirname(__file__), f'LOGS\\{date.today()}.txt')

client = discord.Client()
embed = discord.Embed()


@client.event
async def on_ready():
  print("Bot is ready to party, logged in as {0.user}.".format(client))

@client.event
async def on_message(message):
  global keyword
  full_user = (f"{message.author.name}#{message.author.discriminator}")
  current_requester = message.author
  current_channel = message.channel.id
  if message.author == client.user:
    return
  elif message.content.lower().startswith(keyword.lower()) and full_user in auth_users.values():
    req_movie = message.content.lower()[len(keyword):].strip()
    str_req_movie = req_movie
    await message.channel.send(f"Searching for {req_movie.title()}") ; sleep(1)
    await message.channel.send(f"One moment...") ; sleep(1)
    req_movie_rep = ""
    for x in req_movie:
        if x == " ":
          req_movie_rep += "%"
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
      await message.channel.send(f"No results found for '{str_req_movie}'") ; sleep(1)
      await message.channel.send(f"Let's try searching the internet for it...") ; sleep(1)
      await message.channel.send(f"https://letmegooglethat.com/?q={google_search_req}%3F")
      return  
    print_list = {}
    for x in html["results"]:
        x["release_date"] = x.get("release_date", "Release date unavailable")
        x["title"] = x.get("title", "Title unavailable")
        x["poster_path"] = x.get("poster_path", "/dykOcAqI01Fci5cKQW3bEUrPWwU.jpg")
        x["overview"] = x.get("overview", "Description unavailable.")
        if x["overview"] == "":
          x["overview"] = "Description unavailable."
        if x["poster_path"] == "Null":
          x["poster_path"] = "/dykOcAqI01Fci5cKQW3bEUrPWwU.jpg"
        print_list[x["original_title"]] = [x["id"], x["poster_path"], x["title"], x["release_date"], x["overview"]]
    with io.open(last_movies, "w", encoding = "UTF-8") as last_movies_w:
        json.dump(print_list, last_movies_w)
    with io.open(last_movies, "r", encoding = "UTF-8") as last_movies_r:
        list_of_movies = json.load(last_movies_r)
    selected_movie_id = ""
    number_of_results = len(list_of_movies.keys())
    count_1 = 0
    for x,y in list_of_movies.items():
        await message.channel.send("Is this the correct movie?") ; sleep(1)
        embed.set_image(url=f"https://image.tmdb.org/t/p/original{y[1]}")
        await message.channel.send(embed=embed)
        await message.channel.send(f"`{y[2]} ({y[3]})`\n```{y[4]}```")
        player_choice = await client.wait_for('message', check=lambda message: message.author == current_requester and message.channel.id == current_channel)
        if player_choice.content.lower().strip() == "yes":
          await message.channel.send(f"Selected: `{y[2]} ({y[3]})`") ; sleep(2)
          selected_movie_id = y[0]
          break
        else:
          count_1 += 1
          if count_1 == number_of_results:
            await message.channel.send(f"Unfortunately, we have run out of results.") ; sleep(1)
            await message.channel.send(f"It's possible that this movie does not exist, let's check if it does and try again...") ; sleep(1)
            await message.channel.send(f"https://letmegooglethat.com/?q={google_search_req}%3F")
            return
          else:
            pass
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
    else:
        await message.channel.send(f"{str_req_movie} is being downloaded to {SERVER_NAME}.") ; sleep(1)
        await message.channel.send(f"Please wait: {avg_time_download} seconds...") ; sleep(avg_time_download)
        await message.channel.send(f"If movie is not currently on {SERVER_NAME}, please contact {ADMIN_NAME}.")
  elif message.content.startswith("!df set keyword") and full_user in auth_users.values():
    keyword = message.content.strip()[13:]
    await message.channel.send(f"You can now request movies with '{keyword}'.")
  elif message.content.lower().startswith("!df add user") and full_user in auth_users.values():
    added_user = message.content.strip()[12:]
    count = 1
    for x in auth_users.keys():
      count += 1
    auth_users[str(count)] = added_user.strip() ; sleep(1)
    await message.channel.send(f"{added_user.strip()} has been added to authorized users!")
    with open(AUTH_USER_PATH, "w") as auth_user_json:
      json.dump(auth_users, auth_user_json)
  elif message.content.lower().startswith("!df help") and full_user in auth_users.values():
        await message.channel.send(f"'{keyword}'\n'!df set keyword <new keyword>'\n'!df add user <user>'\n\n'For more help, visit https://github.com/nickheyer/DiscoFlix'")
  else:
    return

client.run(TOKEN)