# DiscoFlix

![DF_Logo_64](https://user-images.githubusercontent.com/60236014/181656541-07810357-318a-4357-aa4f-642e306b14e9.png)

A ~~simple~~ media-requesting, Radarr/Sonarr-interfacing, movie and tv show-listing Chat Bot web-app for your media server. 

As this bot is intended for requests to be fulfilled via Radarr or Sonarr, you must have Radarr or Sonarr installed to use this bot. (https://github.com/Radarr/Radarr & https://sonarr.tv/#download). Along with radarr and sonarr, you must have either discord or telegram. Running the discord bot requires a discord developer account (https://discord.com/developers/applications), and a bot created/invited (via your developer acount) to your chosen discord server. Running the Telegram bot requires a Bot Token which you can acquire (https://telegram.me/BotFather) on Telegram via the "BotFather".
<hr />

## Installation via Docker (Recommended)

- Docker must be installed on your machine. Click [here](https://docs.docker.com/engine/install/) to install Docker.
- Discord and/or Telegram API Token
    - Discord API Token (https://discord.com/developers/applications) - READ [THIS](#further-notes)
    - Telegram API Token  - (https://telegram.me/BotFather)
- Radarr API Key (Radarr GUI>Settings>General>API Key)
- Radarr Host URL (The url you use to access your radarr interface, ex: http://localhost:6585 or http://192.168.1.76:6585)
- Sonarr API Key (Sonarr GUI>Settings>General>API Key)
- Sonarr Host URL (The url you use to access your sonarr interface, ex: http://localhost:8989 or http://192.168.1.76:8989)
- Name of media server that requests will be populated on (ex: NickFlix)
- Full Discord or Telegram username of Admin for first time use (ex: NicholasHeyer#4212)

Download Docker Image (x86_64 Architecture) 
```
docker image pull nickheyer/discoflix:latest
```

-or-

Download Docker Image (aarch64 Architecture, ie: Raspberry-Pi) 
```
docker image pull nickheyer/discoflix_rpi:latest
```
Run Docker Container
```
docker run -d -p 5000:5000 nickheyer/discoflix
```

- The server within the docker container automatically maps to it's network IP (ex:192.168.76.128), and can therefore be accessed elsewhere on the network (ex: [127.0.0.1:5000](127.0.0.1:5000) if run locally, ex: [192.168.1.163:5000](192.168.1.163:5000) if run on another network device)
<hr />


## Manual Installation

Prerequisites:

- Python must be installed on your machine. [Click Here](https://www.python.org/ftp/python/3.10.4/python-3.10.4-amd64.exe) for 64-bit installer - During installation, make sure you select the option "Add Python to environmental variables"
- Discord and/or Telegram API Token
    - Discord API Token (https://discord.com/developers/applications) - READ [THIS](#further-notes)
    - Telegram API Token  - (https://telegram.me/BotFather)
- Radarr API Key (Radarr GUI>Settings>General>API Key)
- Radarr Host URL (The url you use to access your radarr interface, ex: http://localhost:6585 or http://192.168.1.76:6585)
- Sonarr API Key (Sonarr GUI>Settings>General>API Key)
- Sonarr Host URL (The url you use to access your sonarr interface, ex: http://localhost:8989 or http://192.168.1.76:8989)
- Name of media server that requests will be populated on (ex: NickFlix)
- Full Discord or Telegram username of Admin for first time use (ex: NicholasHeyer#4212)


Change Directory to where you would like to install DiscoFlix
```
cd path/of/where/you/would-like-to-install-discoflix
```

Download DiscoFlix by running the below command
```bash
git clone https://github.com/nickheyer/DiscoFlix
```

Change to DiscoFlix Directory
```
cd ./DiscoFlix
```

Install Requirements
```
pip install -r requirements.txt 
```

### On Windows:

Run The Program (or double-click the `run.cmd` file)
```
.\run.cmd
```
This will start a local web-server [HERE](http://127.0.0.1:5000).
Closing the CMD closes the webserver. To host the server on a different port, edit the `run.cmd` file (shown in the below code-block).
```
//Contents of run.cmd
waitress-serve --host 0.0.0.0 --port 5000 app:app
```
If you would like to access the interface from another machine on your local network (or elsewhere with port forwarding), for example if you were running this on a headless server - change the contents of `run.cmd` to the below code block. You would then access the interface via your Network IP (ex: http://192.168.1.76:5000)

### On Linux: 

Run The Program (or double-click the `run.cmd` file)
```
./run.sh
```

By default, the linux webserver is accessible via LAN. You can change the port by changing the value PORT in the run.sh script, see below.
```
#!/bin/sh

IP=0.0.0.0
PORT=5000

gunicorn --bind $IP:$PORT app:app
echo "Shutting down Gunicorn Server"
```

<hr />



Fill in the required information by pressing the "edit" tab or within the json itself ("values" tab), start the bot by moving the switch labeled Bot I/O, profit. If you run into any errors, make sure all fields are completed in the edit tab. Make sure that you add your own "discordusername#1234" or "telegramusername" to admins otherwise the bot will not respond to you. 

![edit_tab_info](https://user-images.githubusercontent.com/60236014/181657291-75e4192f-f5b6-41e1-b296-dcd6abcffe69.png)

![bot_io](https://user-images.githubusercontent.com/60236014/181657296-dac2f704-49db-4cdc-afb5-62c92e142cf3.png)

## Operation Instructions

- To request a movie, type the default prefix "!df" then "movie" and then your movie name. For example: "!df movie Dark Phoenix".
- To request a tv-show, type the default prefix "!df" then "tv-show" and then your show name. For example: "!df tv-show The Walking Dead".
- The bot will then respond with all relevant titles matched with your query to TMDB/TVDB/IMDB. In 90% of cases, the first listing is the correct one, but if it isn't, go ahead and type "no", it will give you the next most relevant title. If the movie is correct, type "yes". If you'd like to cancel, type "stop". If you'd like to start-over, type "startover".
- If the selected movie/tv-show is already present in radarr/sonarr's root directory, the bot will respond letting you know that the file(s) already exist(s).
- If the movie/tv-show does not already exist, it will add it to radarr/sonarr's queue using the quality preset "ANY".
(For movies only) Based on the average download time you provided during setup, it will send a message to discord letting requester know to check the server.
- To add more users from within the Discord bot and not web-app:

    - To allow other people to request movies, it's very simple. Just type the default prefix "!df" then "add-user" then their full discord or telegram username. For example: "!df add-user NicholasHeyer#4212" (Discord) or "!df add-user NicholasHeyer" (Telegram)

        - Reminder: You can also add users via the web-app interface [HERE](http://127.0.0.1:5000).
        -  The web interface accepts comma seperated values (ie: "Username#0000, UsernameNumberTwo#0001, lowercaseusername#0002, telegramusername")
- To change request keyword:

    i. Type "!df set keyword" then the keyword. For example: "!df set keyword !add". Your movie requests will then look like this:         "!add movie Dark Phoenix".

## Further Notes

- When inviting your Discord Bot to channel, make sure you allow permissions as such (see below image). For the most part, the bot only requires text channel permissions, but for admin actions it must grab all the member objects from channel to scan for available admins, therefore it's better to just allow for Administrator priveledges overall.

![image](https://user-images.githubusercontent.com/60236014/181997169-4b7f3c1d-dc72-4ca2-83db-bcea56814bea.png)

![image](https://user-images.githubusercontent.com/60236014/181997296-0aa40040-34f0-4f56-ab87-34a396493417.png)

- For any other comments or questions, feel free to reach me on discord via NicholasHeyer#4212




## Authors

- [@nickheyer](https://www.github.com/nickheyer)


## Contributing

Contributions are always welcome!

Email `nick@heyer.app` for ways to get started.
