# DiscoFlix
A media-requesting, Radarr-interfacing, movie-listing Discord Bot for your media server. 

As this bot is intended for requests to be fulfilled via Radarr, you must have Radarr installed to use this bot. (https://github.com/Radarr/Radarr). Along with radarr, you must have discord, as well as a discord developer account (https://discord.com/developers/applications), and a bot created/invited to your chosen discord server. ~~It has also come to my attention that you will likely need the Discord and PyArr libraries installed on your computer as well - added to installation instructions.~~

Installation instructions:

1. Make sure you have the following API Keys and relevant info:
    1. Discord API Key (https://discord.com/developers/applications)
    2. Radarr API Key (Radarr GUI>Settings>General>API Key)
    3. Radarr Host URL (The url you use to access your radarr interface, ex: http://localhost:6585)
    4. The Movie Database API Key (https://www.themoviedb.org/settings/api)
    5. Name of media server that requests will be populated on (ex: NickFlix)
    6. Full Discord username of Admin for first time use (ex: NastyNick#4212)
~~2. Make sure you have the following libraries installed by running these two commands in command prompt:
    1. "pip install discord"
    2. "pip install pyarr"
    3. If command prompt does not recognize the pip command, you must add your python library folder to your PATH in Env variables. Google "how to add python to PATH".~~
4. ~~Download and Unzip the file "DiscoFlix_Portable.zip".~~ Download and install "DiscoFlix_Setup.exe"
5. Click the DiscoFlix icon, a command prompt will ask you for all the above required information.
6. If your command prompt displays "Bot is ready to party, logged in as 'BOT####'", you should be good to go, assuming all the above steps were completed. 

Operation instructions:

1. To request a movie, type the default prefix "!df request" and then your movie name. For example: "!df Dark Phoenix".
2. The bot will then respond with all relevant titles matched with your query to TMDB. In 90% of cases, the first listing is the correct one, but if it isn't, go ahead and type "no", it will give you the next most relevant title. If the movie is correct, type "yes". 
3. If the selected movie is already present in radarr's root directory, the bot will respond letting you know that the file already exists.
4. If the movie does not already exist, it will add it to radarr's queue using the quality preset "ANY". 
5. Based on the average download time you provided during setup, it will send a message to discord letting requester know to check the server. 

To add more users:

1. To allow other people to request movies, it's very simple. Just type "!df add user" then their full discord username. For example: "!df add user NastyNick#4212)
2. You can also manually add users via the .json file "auth_users.json". For example: {"1": "NastyNick#4212", "2": "INSERT NEW USER HERE"}

To change request keyword:

1. Type "!df set keyword" then the keyword. For example: "!df set keyword !addmovie". Your movie requests will then look like this: "!addmovie Dark Phoenix".

For any other comments or questions, feel free to reach me on discord via NastyNick#4212
