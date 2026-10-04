#!/usr/bin/env bash
# Task 5-a E2E verification suite (runs in one shot: starts the dev server,
# executes the curl matrix, prints labeled results).
set -u
cd /home/z/my-project

BASE=http://localhost:3000
ADMIN="Cookie: foundry-role=admin"
VIEWER="Cookie: foundry-role=viewer"

# ── start dev server if not listening ────────────────────────────────
if ! curl -s -o /dev/null --max-time 3 "$BASE/api/health"; then
  echo "[boot] starting dev server..."
  setsid nohup bash -c 'bun next dev -p 3000 2>&1 | tee -a dev.log' >/dev/null 2>&1 </dev/null &
fi
for i in $(seq 1 60); do
  curl -s -o /dev/null --max-time 3 "$BASE/api/health" && break
  sleep 1
done
echo "[boot] health: $(curl -s -o /dev/null -w '%{http_code}' --max-time 5 $BASE/api/health)"

hdr() { echo; echo "━━━ $1 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; }

# 1. transforms list (empty state)
hdr "1. GET /api/transforms (before seed)"
curl -s "$BASE/api/transforms" | jq -c .

# 2. seed demo
hdr "2. POST /api/transforms/seed-demo (1st call)"
SEED=$(curl -s -X POST -H "$ADMIN" "$BASE/api/transforms/seed-demo")
echo "$SEED" | jq -c .

hdr "3. POST /api/transforms/seed-demo (2nd call — idempotency)"
curl -s -X POST -H "$ADMIN" "$BASE/api/transforms/seed-demo" | jq -c .

# 3. viewer guard
hdr "4. POST /api/transforms as viewer (expect 403)"
curl -s -w " [HTTP %{http_code}]" -X POST -H "$VIEWER" -H "Content-Type: application/json" \
  -d '{"name":"x","sourceCode":"1","outputDatasetName":"x"}' "$BASE/api/transforms"; echo

# 4. transforms list shapes
hdr "5. GET /api/transforms (list item shapes, truncated)"
LIST=$(curl -s "$BASE/api/transforms")
echo "$LIST" | jq -c '.transforms[0] | {id,name,description,language,inputs,outputDatasetName,runsCount,latestRun,sourceCodeLen:(.sourceCode|length)}'
SQL_ID=$(echo "$LIST" | jq -r '.transforms[] | select(.name=="Supplier Spend Summary") | .id')
JS_ID=$(echo "$LIST" | jq -r '.transforms[] | select(.name=="Shipment Risk Flags") | .id')
echo "SQL_ID=$SQL_ID JS_ID=$JS_ID"

# 5. run SQL transform
hdr "6. POST /api/transforms/$SQL_ID/run (SQL)"
RUN_SQL=$(curl -s -X POST -H "$ADMIN" "$BASE/api/transforms/$SQL_ID/run")
echo "$RUN_SQL" | jq -c '{status:.run.status, rowCount:.run.rowCount, durationMs:.run.durationMs, outputDatasetId:.run.outputDatasetId, outputVersionNumber:.run.outputVersionNumber, error:.run.error, logs:[.run.logs[].msg]}'
echo "$RUN_SQL" | jq -c '{schema:[.schema[].name], previewFirst2:.preview[:2]}'

# 6. output dataset exists
hdr "7. GET /api/datasets — check published outputs"
curl -s "$BASE/api/datasets" | jq -c '[.datasets[] | select(.name=="Supplier Spend Summary" or .name=="Shipment Risk Flags") | {id,name,currentVersion}]'

# 7. run JS transform
hdr "8. POST /api/transforms/$JS_ID/run (JS)"
RUN_JS=$(curl -s -X POST -H "$ADMIN" "$BASE/api/transforms/$JS_ID/run")
echo "$RUN_JS" | jq -c '{status:.run.status, rowCount:.run.rowCount, durationMs:.run.durationMs, outputVersionNumber:.run.outputVersionNumber, error:.run.error, logs:[.run.logs[].msg]}'
echo "$RUN_JS" | jq -c '{schema:[.schema[].name], previewFirst2:.preview[:2]}'

# 8. transform detail + runs list
hdr "9. GET /api/transforms/$SQL_ID (detail) + /runs"
curl -s "$BASE/api/transforms/$SQL_ID" | jq -c '{name:.transform.name, runsCount:.transform.runsCount, runs:[.runs[] | {status,rowCount,durationMs}]}'
curl -s "$BASE/api/transforms/$SQL_ID/runs?limit=5" | jq -c '{runs:[.runs[] | .status]}'

# 9. SQL sandbox rejection paths
hdr "10. bad-SQL transform run (UPDATE + multi-statement) → expect failed"
BAD=$(curl -s -X POST -H "$ADMIN" -H "Content-Type: application/json" \
  -d '{"name":"qa-bad-sql","language":"sql","sourceCode":"UPDATE shipments SET quantity = 0","inputs":[],"outputDatasetName":"QA Bad SQL"}' \
  "$BASE/api/transforms")
BAD_ID=$(echo "$BAD" | jq -r '.transform.id')
curl -s -X POST -H "$ADMIN" "$BASE/api/transforms/$BAD_ID/run" | jq -c '{status:.run.status, error:.run.error, logs:[.run.logs[].msg]}'
BAD2=$(curl -s -X POST -H "$ADMIN" -H "Content-Type: application/json" \
  -d '{"name":"qa-bad-sql-2","language":"sql","sourceCode":"SELECT 1; SELECT 2","inputs":[],"outputDatasetName":"QA Bad SQL 2"}' \
  "$BASE/api/transforms")
BAD2_ID=$(echo "$BAD2" | jq -r '.transform.id')
curl -s -X POST -H "$ADMIN" "$BASE/api/transforms/$BAD2_ID/run" | jq -c '{status:.run.status, error:.run.error}'
curl -s -X DELETE -H "$ADMIN" "$BASE/api/transforms/$BAD_ID" >/dev/null
curl -s -X DELETE -H "$ADMIN" "$BASE/api/transforms/$BAD2_ID" >/dev/null
echo "[cleanup] bad transforms deleted"

# 10. JS sandbox rejection path
hdr "11. bad-JS transform (returns non-array) → expect failed"
BADJS=$(curl -s -X POST -H "$ADMIN" -H "Content-Type: application/json" \
  -d '{"name":"qa-bad-js","language":"javascript","sourceCode":"return 42","inputs":[],"outputDatasetName":"QA Bad JS"}' \
  "$BASE/api/transforms")
BADJS_ID=$(echo "$BADJS" | jq -r '.transform.id')
curl -s -X POST -H "$ADMIN" "$BASE/api/transforms/$BADJS_ID/run" | jq -c '{status:.run.status, error:.run.error}'
curl -s -X DELETE -H "$ADMIN" "$BASE/api/transforms/$BADJS_ID" >/dev/null
echo "[cleanup] bad-js transform deleted"

# 11. pruning
hdr "12. PATCH /api/datasets/<activeShipments> {keepLastN:5} + POST prune"
AS_ID=$(curl -s "$BASE/api/datasets" | jq -r '.datasets[] | select(.name=="Active Shipments") | .id')
echo "AS_ID=$AS_ID versions before: $(curl -s "$BASE/api/datasets/$AS_ID" | jq '.versions | length')"
curl -s -X PATCH -H "$ADMIN" -H "Content-Type: application/json" -d '{"keepLastN":5}' "$BASE/api/datasets/$AS_ID" | jq -c '{name:.dataset.name, keepLastN:.dataset.keepLastN, versionsCount:.dataset.versionsCount}'
PRUNE=$(curl -s -X POST -H "$ADMIN" "$BASE/api/datasets/$AS_ID/prune")
echo "$PRUNE" | jq -c .

# 12. projects CRUD
hdr "13. POST /api/projects → PATCH → DELETE"
PROJ=$(curl -s -X POST -H "$ADMIN" -H "Content-Type: application/json" -d '{"name":"Supply Chain Ops"}' "$BASE/api/projects")
PROJ_ID=$(echo "$PROJ" | jq -r '.project.id')
echo "$PROJ" | jq -c .
curl -s -X PATCH -H "$ADMIN" -H "Content-Type: application/json" -d '{"description":"M0 ops space"}' "$BASE/api/projects/$PROJ_ID" | jq -c .
curl -s -w " [HTTP %{http_code}]" -X DELETE -H "$ADMIN" "$BASE/api/projects/$PROJ_ID"; echo
echo "[check] project gone: $(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/projects/$PROJ_ID")"

# 13. audit trail sanity
hdr "14. GET /api/audit — recent transform/project/dataset.prune entries"
curl -s "$BASE/api/audit?limit=12" | jq -c '[.entries[] | {actorRole,action,resourceType,resourceName,detail}]'

echo; echo "[done]"
