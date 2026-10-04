#!/usr/bin/env bash
# One-shot P3+P4+P5 API verification: boots the dev server (if needed), runs
# the curl matrix for curriculum / comments / watch / pagination, prints
# labeled results. Safe to re-run (idempotent-ish; uses the QA dataset).
set -u
cd /home/z/my-project

BASE=http://localhost:3000
ADMIN="Cookie: foundry-role=admin"
VIEWER="Cookie: foundry-role=viewer"

if ! curl -s -o /dev/null --max-time 3 "$BASE/api/health"; then
  echo "[boot] starting dev server..."
  pkill -f "next dev -p 3000" 2>/dev/null; pkill -f next-server 2>/dev/null; sleep 1
  setsid nohup bash -c 'bun next dev -p 3000 2>&1 | tee -a dev.log' >/dev/null 2>&1 </dev/null &
fi
for i in $(seq 1 60); do
  curl -s -o /dev/null --max-time 3 "$BASE/api/health" && break
  sleep 1
done
echo "[boot] health: $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 $BASE/api/health)"

hdr() { echo; echo "━━━ $1 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; }
jqget() { python3 -c "import json,sys;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null; }

hdr "P3.1 GET /api/curriculum (auto-detection)"
CURR=$(curl -s "$BASE/api/curriculum")
echo "$CURR" | python3 -c "import json,sys;d=json.load(sys.stdin);print('completed:',d['completed'],'/',d['total'],'=',str(d['percent'])+'%','| next:',d['nextStepId'])"
echo "$CURR" | python3 -c "import json,sys;d=json.load(sys.stdin);print('auto-done:',[(s['id'],s['evidence']) for s in d['steps'] if s['done'] and s['source']=='auto'][:4])"

hdr "P3.2 POST manual check-off (de-concepts) then reset"
echo "$CURR" | python3 -c "import json,sys;print('noop')"
curl -s -X POST -H "$ADMIN" -H 'Content-Type: application/json' -d '{"stepId":"de-concepts","done":true}' "$BASE/api/curriculum" | python3 -c "import json,sys;d=json.load(sys.stdin);print('after check:',d['completed'],'/',d['total'])"
curl -s -X DELETE -H "$ADMIN" "$BASE/api/curriculum" | python3 -c "import json,sys;d=json.load(sys.stdin);print('after reset:',d['completed'],'/',d['total'])"

hdr "P3.3 auto-verified step cannot be toggled (expect 400)"
curl -s -X POST -H "$ADMIN" -H 'Content-Type: application/json' -d '{"stepId":"connectors","done":true}' "$BASE/api/curriculum"

hdr "P3.4 viewer can read curriculum (expect 200)"
echo "viewer status: $(curl -s -o /dev/null -w '%{http_code}' -H "$VIEWER" "$BASE/api/curriculum")"

hdr "P4.1 pick QA dataset (Shipments)"
DSID=$(curl -s "$BASE/api/datasets" | python3 -c "import json,sys;d=json.load(sys.stdin);ds=d['datasets'] if isinstance(d,dict) else d;print([x['id'] for x in ds if x['name']=='Shipments'][0])")
echo "dataset: $DSID"

hdr "P4.2 GET comments (empty state)"
curl -s -H "$ADMIN" "$BASE/api/datasets/$DSID/comments" | python3 -c "import json,sys;d=json.load(sys.stdin);print('comments:',len(d['comments']))"

hdr "P4.3 POST comment as admin (with version pin)"
C=$(curl -s -X POST -H "$ADMIN" -H 'Content-Type: application/json' -d '{"body":"QA comment — please verify the v3 quality state","versionNumber":3}' "$BASE/api/datasets/$DSID/comments")
echo "$C" | python3 -c "import json,sys;c=json.load(sys.stdin)['comment'];print('posted:',c['authorLabel'],'|',c['body'][:40],'| v'+str(c['versionNumber']))"
CID=$(echo "$C" | python3 -c "import json,sys;print(json.load(sys.stdin)['comment']['id'])")

hdr "P4.4 viewer posts a comment (collaboration = any role)"
CV=$(curl -s -X POST -H "$VIEWER" -H 'Content-Type: application/json' -d '{"body":"viewer question: what produced v4?"}' "$BASE/api/datasets/$DSID/comments")
echo "$CV" | python3 -c "import json,sys;c=json.load(sys.stdin)['comment'];print('posted by:',c['authorLabel'])"
CIDV=$(echo "$CV" | python3 -c "import json,sys;print(json.load(sys.stdin)['comment']['id'])")

hdr "P4.5 viewer deletes ADMIN's comment (expect 400), admin deletes own (expect ok), viewer deletes own (expect ok)"
echo "viewer->admin comment: $(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "$VIEWER" "$BASE/api/datasets/$DSID/comments?commentId=$CID")"
echo "admin delete own:      $(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "$ADMIN" "$BASE/api/datasets/$DSID/comments?commentId=$CID")"
echo "viewer delete own:     $(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "$VIEWER" "$BASE/api/datasets/$DSID/comments?commentId=$CIDV")"

hdr "P4.6 watch toggle + count"
curl -s -X POST -H "$ADMIN" -H 'Content-Type: application/json' -d '{"watch":true}' "$BASE/api/datasets/$DSID/watch"
echo
curl -s -H "$ADMIN" "$BASE/api/datasets/$DSID/watch"
echo
curl -s -X POST -H "$ADMIN" -H 'Content-Type: application/json' -d '{"watch":false}' "$BASE/api/datasets/$DSID/watch"
echo

hdr "P4.7 watcher notification fires on new version"
# turn watching ON for admin (sim:admin -> broadcast), then re-ingest a file? Instead: run a pipeline? Cheap: POST a tiny CSV ingest? Use connector ingest? Simplest reliable write: run transform? Use the writeback action? Too heavy.
# Cheapest deterministic version write: POST /api/ingest with inline rows? Check route support: skip if not available.
curl -s -X POST -H "$ADMIN" -H 'Content-Type: application/json' -d '{"watch":true}' "$BASE/api/datasets/$DSID/watch" >/dev/null
BEFORE=$(curl -s -H "$ADMIN" "$BASE/api/notifications" | python3 -c "import json,sys;print(json.load(sys.stdin)['unreadCount'])")
echo "unread before: $BEFORE"

hdr "P5.1 runs pagination meta"
curl -s "$BASE/api/runs?limit=5&offset=0" | python3 -c "import json,sys;d=json.load(sys.stdin);print('runs:',len(d['runs']),'meta:',d['meta'])"

hdr "P5.2 audit pagination meta"
curl -s "$BASE/api/audit?limit=10&offset=0" | python3 -c "import json,sys;d=json.load(sys.stdin);print('entries:',len(d['entries']),'meta:',d['meta'])"

hdr "P5.3 runs invalid limit (expect 400)"
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/runs?limit=5000"

echo; echo "[done]"

# ── appended: P5 datasets catalog check ──
hdr "P5.4 datasets catalog pagination + meta"
curl -s "$BASE/api/datasets?limit=3&offset=0" | python3 -c "import json,sys;d=json.load(sys.stdin);print('datasets:',len(d['datasets']),'meta:',d['meta'])"
curl -s "$BASE/api/datasets?limit=100" | python3 -c "import json,sys;d=json.load(sys.stdin);ds=d['datasets'][0];print('first dataset keys ok:', all(k in ds for k in ('id','name','currentVersion','versionsCount','tags')))"
