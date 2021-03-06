# DiscoFlix
A simple media-requesting, Radarr/Sonarr-interfacing, movie and tv show-listing Discord Bot for your media server. 

As this bot is intended for requests to be fulfilled via Radarr AND Sonarr, you must have Radarr (AND optionally Sonarr) installed to use this bot. (https://github.com/Radarr/Radarr & https://sonarr.tv/#download). Along with radarr and sonarr (again, optional), you must have discord, as well as a discord developer account (https://discord.com/developers/applications), and a bot created/invited (via your developer acount) to your chosen discord server.

Installation instructions:

1. Make sure you have the following API Keys and relevant info:
    1. Discord API Key (https://discord.com/developers/applications)
    2. Radarr API Key (Radarr GUI>Settings>General>API Key)
    3. Radarr Host URL (The url you use to access your radarr interface, ex: http://localhost:6585)
    2. (optional) Sonarr API Key (Sonarr GUI>Settings>General>API Key)
    3. (optional) Sonarr Host URL (The url you use to access your sonarr interface, ex: http://localhost:8989)
    5. The Movie Database API Key (https://www.themoviedb.org/settings/api)
    6. Name of media server that requests will be populated on (ex: NickFlix)
    7. Full Discord username of Admin for first time use (ex: NastyNick#4212)

4. ~~Download and Unzip the file "DiscoFlix_Portable.zip".~~ Download and install "DiscoFlix_Setup.exe"
5. Click the DiscoFlix icon, a command prompt will ask you for all the above required information.
6. If your command prompt displays "Bot is ready to party, logged in as 'BOT####'", you should be good to go, assuming all the above steps were completed. 

Operation instructions:

1. To request a movie, type the default prefix "!df movie" and then your movie name. For example: "!df movie Dark Phoenix".
2. To request a tv-show, type the default prefix "!df tvshow" and then your show name. For example: "!df tvshow The Walking Dead".
3. The bot will then respond with all relevant titles matched with your query to TMDB/TVDB/IMDB. In 90% of cases, the first listing is the correct one, but if it isn't, go ahead and type "no", it will give you the next most relevant title. If the movie is correct, type "yes". If you'd like to cancel, type "stop". If you'd like to start-over, type "startover".
4. If the selected movie/tv-show is already present in radarr/sonarr's root directory, the bot will respond letting you know that the file(s) already exist(s).
5. If the movie/tv-show does not already exist, it will add it to radarr/sonarr's queue using the quality preset "ANY". 
6. (For movies only) Based on the average download time you provided during setup, it will send a message to discord letting requester know to check the server. 

To add more users:

1. To allow other people to request movies, it's very simple. Just type "!df add user" then their full discord username. For example: "!df add user NastyNick#4212)
2. You can also manually add users via the .json file "auth_users.json". For example: {"1": "NastyNick#4212", "2": "INSERT NEW USER HERE"}

To change request keyword:

1. Type "!df set keyword" then the keyword. For example: "!df set keyword !add". Your movie requests will then look like this: "!add movie Dark Phoenix".

For any other comments or questions, feel free to reach me on discord via NastyNick#4212
