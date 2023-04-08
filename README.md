# DiscoFlix
![image](https://user-images.githubusercontent.com/60236014/230698969-6d09c60e-b265-4ef2-8e79-08140e04d3bc.png)


### The ideal way for you and your users to request media via Discord. Compatible with Radarr & Sonarr.

<hr />

![Peek 2023-04-07 20-39](https://user-images.githubusercontent.com/60236014/230701633-986cf0d0-0534-498e-8f4b-26e413c2b241.gif)

<hr />
<br />


## General Requirements
Running the discord bot requires a [discord developer account](https://discord.com/developers/applications), and a bot created/invited (via your developer account) to your chosen discord server.

As this application is intended to interface with [Sonarr](https://sonarr.tv) and [Radarr](https://radarr.video), you will need one or both installed. If you are installing to a machine that is not also hosting your Radarr/Sonarr, you must be able to access Radarr/Sonarr from the host (locally or remotely).

<br />


## Installation (Recommended Method)

### Linux -- Fully Automated Install & Updates

```bash 
curl https://raw.githubusercontent.com/nickheyer/DiscoFlix/main/installer/auto_install_update.sh -o auto_install_update.sh && sudo bash auto_install_update.sh
```

### Other Operating Systems (Windows/Mac) or (Manual Docker Installation)


##### Download Docker Image (x86_64 Architecture) 
```bash
docker image pull nickheyer/discoflix:latest
```
##### Download Docker Image (aarch64 Architecture, ie: Raspberry-Pi) 
```bash
docker image pull nickheyer/discoflix_rpi:latest
```
##### Run Docker Container
```bash
docker run -d -p 5454:5454 nickheyer/discoflix
```
##### The server within the docker container can be accessed locally at [http://127.0.0.1:5454](http://127.0.0.1:5454)

<hr />
<br />


## Installation From Source (Not Recommended)

### Prerequisites, Dependencies, and Requirements
**_NOTE:_**  Installation from source using Windows has been deprecated with the introduction of web-socket functionality, gevent, and other integral parts of this application that are not currently supported by Microsoft.

1. Python - Download and install Python [here](https://www.python.org/downloads/). Make sure that you choose "Add Python to environmental variables" during installation.
2. Git - Download and install Git [here](https://git-scm.com/book/en/v2/Getting-Started-Installing-Git)
3. "requirements.txt" - Once you've git-cloned DiscoFlix (see next steps), you will be instructed to install the remaining dependencies found in this file, via `pip install -r requirements.txt`.

### Next Steps

1. Change directory to preferred install location
```bash 
cd /where/you/want/this/installed
```

2. Clone DiscoFlix

```bash 
git clone https://github.com/nickheyer/DiscoFlix
```
 
3. Change directory to DiscoFlix
```bash 
cd ./DiscoFlix
```

4. Install "requirements.txt"
```bash 
pip install -r requirements.txt
```

5. Run DiscoFlix
```bash
sh ./run.sh
```

<hr />
<br />

## General Instructions

#### Accessing The Web-UI

![Peek 2023-04-07 20-49](https://user-images.githubusercontent.com/60236014/230701931-2bf15aaa-93e5-4060-89a8-60233f0ac211.gif)

#### *You will need to get the IP address of the computer hosting DiscoFlix. On Windows, you would typically type `ipconfig` on the host machine and look for your `ipv4`.*

> If you are hosting DiscoFlix (using Docker) on the same machine that you are hosting Radarr & Sonarr, you won't be able to access your Radarr & Sonarr using `http://localhost:<port>`, as that would be referencing the localhost of the docker container itself. Instead, use `http://host.docker.internal:<port>` - consider this the `localhost` of the machine hosting the docker container.

#### *If you would like to access DiscoFlix remotely, as in not on the same network as the host machine, you will need to do some port forwarding to expose port 5454 to the internet. If you run into any trouble here, feel free to join the [Discord](https://discord.com/invite/6Z9yKTbsrP)!*

<hr />

### Configuration

![Peek 2023-04-07 19-50](https://user-images.githubusercontent.com/60236014/230700291-5b3149af-2eb6-4d41-99d9-50c93a5049b7.gif)
#### *DiscoFlix requires a small amount of configuration before you can begin making requests. Discord Token + Radarr and/or Sonarr URL and Token, depending on your use case. If you plan to only use Radarr, disable the Sonarr switch in your configuration menu. Same goes for only using Sonarr.*

<hr />

![Peek 2023-04-07 20-01](https://user-images.githubusercontent.com/60236014/230700480-36a89984-59ea-4c65-a269-1d4e34230872.gif)
#### *If you haven't already, now is also a good time to invite the bot to the server or servers you would like to monitor, you can do that via the Discord Developer Portal. Admin access is the only level we have tested. Anything less may result in errors.*

<hr />
<br />

## Usage


### Add Yourself As An Admin
![Peek 2023-04-07 20-10](https://user-images.githubusercontent.com/60236014/230700808-3e6c6663-4d42-467f-9130-542f054b73ce.gif)




### Test That The Bot Is Running
Type the following into a discord chat message that the bot can see:

```
!df test
```

![Peek 2023-04-07 20-15](https://user-images.githubusercontent.com/60236014/230700917-a54846b6-804c-461f-83df-fa2c6b003e64.gif)

### Your First Request
Test that the bot is able to access Radarr/Sonarr by making your first test request. Let's use "Dark Phoenix" as an example.

```
!df movie Dark Phoenix
```
![Peek 2023-04-07 20-21](https://user-images.githubusercontent.com/60236014/230701093-3d2afff4-605a-4f04-97af-446fba9e79c7.gif)

We can also test our Sonarr requests. Let's try "Cyberpunk Edgerunners".

```
!df show Cyberpunk Edgerunners
```
![Peek 2023-04-07 20-23](https://user-images.githubusercontent.com/60236014/230701137-9c13eb0d-88b1-4fce-9479-e3288742f615.gif)

*Looks like we already have that on our server, or it's already being monitored!*


## Further Notes


- For any other comments or questions, feel free to reach me on discord via NicholasHeyer#4212
- Feel free to join the [Discord](https://discord.com/invite/6Z9yKTbsrP)!


<br />

## Authors

- [@nickheyer](https://www.github.com/nickheyer)


## Contributing

Contributions are always welcome!

Email `nick@heyer.app` for ways to get started.
