#!/usr/bin/env bash
# Dev-server guard: keeps next dev alive on :3000 across sandbox reaps.
# Started detached (setsid). Loop checks health; on failure, boots the server
# with the worklog-approved pattern and waits for it to come back.
set -u
cd /home/z/my-project

while true; do
  if ! curl -s -o /dev/null --max-time 3 http://localhost:3000/api/health; then
    # make sure no stale listener/zombie holds the port
    pkill -f "next dev -p 3000" 2>/dev/null
    pkill -f "next-server" 2>/dev/null
    sleep 1
    setsid nohup bash -c 'bun next dev -p 3000 2>&1 | tee -a dev.log' >/dev/null 2>&1 </dev/null &
    for i in $(seq 1 60); do
      curl -s -o /dev/null --max-time 3 http://localhost:3000/api/health && break
      sleep 1
    done
  fi
  sleep 10
done
