#!/usr/bin/env bash

mkdir dist
cp Dockerfile dist
cp -r src/* dist
cp *.json dist