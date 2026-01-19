#!/usr/bin/env bash

APP=atc-frontend
docker build --platform linux/amd64 -t "$APP" .
