#!/bin/sh
if [ "$1" = "--auth" ]; then
  exec python main.py auth
else
  if [ -n "$GH_TOKEN" ]; then
    exec python main.py start --host 0.0.0.0 -g "$GH_TOKEN" "$@"
  else
    exec python main.py start --host 0.0.0.0 "$@"
  fi
fi
