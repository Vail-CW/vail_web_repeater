#! /bin/sh

set -e

cd $(dirname $0)/..

target=vail-repeater
VERSION=${1:-latest}
tag=$target:$VERSION

echo "==== Building $tag"
docker build \
    --tag $tag \
    -f build/Dockerfile \
    .
