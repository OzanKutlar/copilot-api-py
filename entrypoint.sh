#!/bin/sh
# The container always runs the HTTP proxy (--server): it has no display for
# the desktop window, and .dockerignore keeps any CombineWebUI clone out.
if [ "$1" = "--auth" ]; then
  exec python main.py auth
else
  if [ -n "$GH_TOKEN" ]; then
    exec python main.py start --server --host 0.0.0.0 -g "$GH_TOKEN" "$@"
  else
    exec python main.py start --server --host 0.0.0.0 "$@"
  fi
fi
