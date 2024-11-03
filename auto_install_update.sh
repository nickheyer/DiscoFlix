#!/bin/bash
set -e

# Universal Install & Update Script for DiscoFlix by Nicholas Heyer

# USE ENV VARIABLE IF PROVIDED, OTHERWISE USE SCRIPT DEFAULTS
app_name="${APP_NAME:-DiscoFlix}"
docker_user="${DOCKER_USER:-nickheyer}"
docker_app="${DOCKER_APP:-discoflix}"
docker_repo="${docker_user}/${docker_app}"
outer_port="${DOCKER_PORT_HOST:-5454}"
inner_port="${DOCKER_PORT_CONTAINER:-5454}"
ports="${outer_port}:${inner_port}"
host_volume_dir="${HOST_VOLUME_DIR:-/opt/discoflix/data}"
container_data_path="${CONTAINER_DATA_PATH:-/app/data}"
volume_path="${host_volume_dir}:${container_data_path}"
service_file="/etc/systemd/system/docker-${docker_app}.service"
create_service="${CREATE_SERVICE:-1}"

# CHECK ROOT
if [ "$EUID" -ne 0 ]; then
    echo "This script requires root access. Please run with sudo: sudo bash $0"
    exit 1
fi

# CHECK FOR DOCKER, INSTALL IF NEEDED
which docker > /dev/null || {
  read -p "Docker is not installed. Would you like to install Docker? (y/N): " ans
  if [[ $ans != "y" ]]; then
    echo "Installation aborted. Exiting."
    exit 1
  fi
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com -o get-docker.sh
  sh get-docker.sh
  rm get-docker.sh
}

# CREATE SYSTEMD SERVICE IF SYSTEMD IS PRESENT AND CREATE_SERVICE IS TRUE
if command -v systemctl &> /dev/null && [[ "$create_service" -eq 1 ]]; then
    if [ -f "$service_file" ]; then
        echo "Stopping existing ${app_name} service..."
        systemctl stop "docker-${docker_app}.service"
    else
        echo "Creating systemd service file for ${app_name}..."
        cat << EOF > "$service_file"
[Unit]
Description=${app_name} Service
Requires=docker.service
After=docker.service

[Service]
Restart=always
ExecStart=$(which docker) run -d -p "${ports}" -v "${volume_path}" --name "${docker_app}" "${docker_repo}"
ExecStop=$(which docker) stop ${docker_app}

[Install]
WantedBy=multi-user.target
EOF
        systemctl daemon-reload
    fi
else
    echo "Skipping creation of systemd service file."
fi

# MAKE SURE VOL MOUNT DIR EXISTS
if [ ! -d "$host_volume_dir" ]; then
    echo "Creating volume directory at $host_volume_dir..."
    mkdir -p "$host_volume_dir"
    chmod 777 "$host_volume_dir"
fi

# CHECK FOR EXISTING CONTAINER
if docker container inspect "$docker_app" &> /dev/null; then
    echo "Existing ${app_name} container detected."

    # CHECK FOR VOL MOUNT
    mounts=$(docker inspect -f '{{ range .Mounts }}{{ .Destination }} {{ end }}' "$docker_app")
    if [[ ! $mounts =~ $container_data_path ]]; then
        echo "No volume mount detected for data. Backing up data from the running container..."

        # COPY DATA FROM CONTAINER TO HOST MOUNT
        docker cp "${docker_app}:${container_data_path}/." "$host_volume_dir"
        echo "Data backup completed to ${host_volume_dir}."
    else
        echo "Volume mount detected. No data backup needed."
    fi

    # STOP + RM CONTAINER
    echo "Stopping and removing the existing ${app_name} container..."
    docker container stop "$docker_app"
    docker container rm "$docker_app"
fi

# PULL IMAGE
echo "Pulling the latest image for ${app_name}..."
docker pull "$docker_repo"

# RUN CONTAINER
echo "Starting ${app_name} container..."
docker run -d -p "${ports}" -v "${volume_path}" --name "${docker_app}" "${docker_repo}"

# START SYSTEMD SERVICE IF SYSTEMD IS PRESENT AND CREATE_SERVICE IS TRUE
if command -v systemctl &> /dev/null && [[ "$create_service" -eq 1 ]]; then
    echo "Enabling and starting ${app_name} service..."
    systemctl enable "docker-${docker_app}.service"
    systemctl start "docker-${docker_app}.service"
fi

# VERIFY RUNNING CONTAINER
if [ "$(docker container inspect -f '{{.State.Running}}' "$docker_app")" == "true" ]; then
    echo "${app_name} is successfully installed and running!"
    ip=$(hostname -i | cut -f1 -d' ') || '127.0.1.1'
    port=$(echo $outer_port)

    echo " "
    echo "-----------------------------------------------------------------------------------------------"
    echo " "

    echo "${app_name} should be remotely accessible via http://${ip}:${port}"

    echo " "
    echo "-----------------------------------------------------------------------------------------------"
    echo " "
else
    echo "Failed to start ${app_name} container. Please check Docker logs for details."
    exit 1
fi
