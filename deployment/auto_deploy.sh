#!/bin/sh

app="discoflix"
docker_user="nickheyer"

cd ..


if ({
    echo "Building ${app}-image for x86"
    docker build -t "${docker_user}/${app}" .
} && {
    echo "Pushing x86 ${app}-image to dockerhub"
    docker push "${docker_user}/${app}"
})
then
{
    echo "x86 ${app}-image succesfully built and deployed"
}
fi

if ({
    echo "Building ${app}-image for ARM64"
    export DOCKER_CLI_EXPERIMENTAL=enabled
    docker run --rm --privileged docker/binfmt:66f9012c56a8316f9244ffd7622d7c21c1f6f28d
} && {
    {
        docker buildx create --use --name multi-arch-builder
        docker buildx build --platform=aarch64 -t "${docker_user}/${app}_rpi" . --push ;
    } || {
        docker buildx build --platform=aarch64 -t "${docker_user}/${app}_rpi" . --push ;
    }
    
})
then
{
    echo "ARM64 ${app}-image succesfully built and deployed"
}
fi

