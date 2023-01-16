#!/bin/bash

#App-Agnostic-Auto-Install-&-Update-Script created by Nicholas Heyer originally for DiscoFlix (https://github.com/nickheyer/DiscoFlix)

# .... SCRIPT CONFIGURATION ....

app_name="DiscoFlix" # <-- Required!
declare -a FilesToBackup=("./data/values.json") # <-- Required!
docker_user="nickheyer" # <-- Required!
docker_app="discoflix" # <-- Required!
ports="5000:5000" # <-- Optional


#Checking if script was run as root (with sudo)
if [ "$EUID" -ne 0 ]
  then echo "This script requires root access. Please try again using \"sudo bash $0\""
  exit
fi

# .... Creating TMP dir for backup and install files ....
tmp_dir=$(mktemp -d -t ci-XXXXXXXXXX)

#Determine system architecture
system_arch=$(uname -i)

#Appending repo based on system arch
[[ $system_arch =~ ^arm ]] && docker_app="${docker_app}_rpi"

docker_repo="${docker_user}/${docker_app}"

#Greet user

echo "Initializing ${app_name} Install & Update Script..."

#Detect if Docker is installed

echo "Checking for Docker installation on current machine..."

docker_loc="$(command -v docker)"

if [ ! -z "${docker_loc}" ]
then
    
    echo "Docker is installed, install location saved for future reference..."

else

    while true; do
        read -p "Docker installation not detected on this machine. Would you like to install Docker (required for ${app_name})? " yn
        case $yn in

            [Yy]* )
                echo "Installing Docker via get-docker.com --- Please wait..."
                iscript_loc="${tmp_dir}/get-docker.sh"
                curl -fsSL https://get.docker.com -o $iscript_loc
                sh $iscript_loc
                break
            ;;

            [Nn]* ) 
                echo "Docker is required for installation of ${app_name}. Please install before retrying this installation. Thank you!" 
                exit
            ;;

            * ) echo "Please answer yes or no";;
        esac
    done
fi

#Checking for docker-<docker_app>.service. If service is running, stop service (which stops container).

echo "Handling service file creation and control. Please wait..."

app_service_file="/etc/systemd/system/docker-${docker_app}.service"

echo "Checking if .service file exists at ${app_service_file}. Please wait..."
if [ -f "${app_service_file}" ]
then
    
    echo "Service exists! Stopping any running services associated with ${app_name}. Please wait..."
    systemctl stop "docker-${docker_app}.service"

else

    docker_loc="$(command -v docker)"

    echo "No services exist for this application. Creating service file. Please wait..."
    echo "[Unit]
    Description=${app_name} Service
    Requires=docker.service
    After=docker.service

    [Service]
    Restart=always
    ExecStart=${docker_loc} start -a ${docker_app}
    ExecStop=${docker_loc} stop -t 2 ${docker_app}

    [Install]
    WantedBy=default.target" > "${app_service_file}"
fi

#Checking for running app containers. Stopping them.

echo "Checking for pre-existing ${app_name} containers..."
container_state=$(docker container ls -a --filter name="${docker_app}" --format "{{.State}}")
container_id=$(docker container ls -a --filter name="${docker_app}" --format "{{.ID}}")

[ -z "${container_id}" ] || echo "Container discovered: $container_id is $container_state." 

[ "${container_state}" = "running" ] && echo "Shutting down container. Please wait..." && docker container stop $docker_app #If container is running, stop container


#If app image exists, search for app in running containers.

echo "Checking for ${app_name} images on current machine..."
app_installation=$(docker images "${docker_repo}:latest" --format "{{.Repository}}")

if [ -z "${app_installation}" ] #If app image does not exist
then
    
    echo "No installations of ${app_name} detected. Pulling new image from ${docker_repo}. Please wait..."
    docker pull "${docker_repo}"

else

    while true; do
        read -p "Installation of ${app_name} detected. Would you like to force an update to the most recent version? " yn
        case $yn in

            [Yy]* )
                echo "Pulling most recent image for ${docker_repo}. Please wait..."
                docker pull "${docker_repo}"
                break
            ;;

            [Nn]* ) 
                echo "Skipping update..." 
                break
            ;;

            * ) echo "Please answer yes or no";;
        esac
    done
fi

updated_installation=$(docker images "${docker_repo}:latest") 



#If app container already exists, backup all configs, data, etc. ( See FilesToBackup in SCRIPT CONFIGURATION )

if [ -z "${container_id}" ]
then

    echo "No containers detected. Skipping file backup..."

else

    tmp_img="${docker_app}_tmp"

    echo "Creating temporary image from stopped container..."
    docker commit $container_id $tmp_img

    echo "Running temporary container from temp image..."
    docker run -d --name $tmp_img $tmp_img

    echo "Pulling files from temp container..."
    for file_path in "${FilesToBackup[@]}"; do
        docker exec -it $tmp_img cat $file_path > "${tmp_dir}/$(basename ${file_path})"
    done

    echo "Cleaning up temporary image and containers..."
    docker container rm -f $tmp_img
    docker image rm -f $tmp_img

    #Removing old containers
    echo "Removing old container #${container_id}"
    docker container rm -f $container_id

fi


#Create container using new image

echo "Creating/running container from updated image. Please wait..."
[ -z $ports ] && docker run -d --name $docker_app $docker_repo || docker run -d -p $ports --name $docker_app $docker_repo
new_id=$(docker container ls -a --filter name="${docker_app}" --format "{{.ID}}")

#Injecting backed-up files into new container


if [ -z "${container_id}" ]
then

    echo "No backed up files to inject, skipping container injection. Please wait..."

else

    echo "Injecting backed up files into container. Please wait..."
    for file_path in "${FilesToBackup[@]}"; do
        echo "Injecting ${tmp_dir}/$(basename ${file_path}) -> ${new_id}:${file_path}"
        docker cp "${tmp_dir}/$(basename ${file_path})" "${new_id}:${file_path}"
    done
fi


#Preparing for service start by shutting down new container

echo "Temporarily shutting down ${docker_repo} (will restart with service)..."
docker container stop $docker_app

#Reloading systemctl daemon to populate changes to services

echo "Reloading systemctl daemon to poulate changes to services. Please wait..."
systemctl daemon-reload

#Starting services

echo "Starting docker-${docker_app}.service. Please wait..."
systemctl start "docker-${docker_app}.service"
wait

#Cleaning tmp files
echo "Cleaning up temporary files and removing tmp_dir. Please wait..."
rm -rf $tmp_dir

#Confirming container is running now as it should

echo "Verifying that container is running properly. Please wait..."
new_state=$(docker container ls -a --filter name="${docker_app}" --format "{{.State}}")
while [ ! "${new_state}" = "running" ]
do
    sleep 1
    echo "Service Status: ${new_state}"
    new_state=$(docker container ls -a --filter name="${docker_app}" --format "{{.State}}")
    [ "${new_state}" = "stopped" ] && echo "Container is unable to start. Try running this install script again or try installing manually." && exit
done

echo "${app_name} install/update successful. Container is running!"
