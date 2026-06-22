#!/bin/bash
docker build -t acore .
docker run -it --rm -p 8085:8085 -p 3724:3724 -p 3310:3310 acore
