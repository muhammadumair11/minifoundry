#!/usr/bin/env bash
# MiniFoundry — full-stack smoke test (Phase 7 acceptance gate).
#
# Runs the complete parity journey against a booted stack (default: the
# compose gateway at http://localhost:8080 with the SPA at :3000):
#   health → seed → auth flows → datasets lifecycle (ingest/rows/branches/
#   quality/publish) → connectors → pipelines (run/jobs/replay) → transforms
#   (SQL/JS/Python) → ontology (objects/actions/write-back) → dashboards/
#   applications → governance (markings/masking/approvals/audit/acl/
#   notifications/curriculum/settings) → search/stats → public API v1
#   (token auth + rate limits) → shared-mode wall.
#
# Contract SHAPE verification lives in scripts/verify-contracts.mjs; this
# script verifies FLOWS + invariants + cross-service behavior end to end.
#
# Usage:
#   bash scripts/smoke.sh [BASE_URL]        # default http://localhost:8080
# Env:
#   MF_SMOKE_ADMIN_EMAIL / MF_SMOKE_ADMIN_PASSWORD (default seeded demo admin)

set -u
BASE="${1:-http://localhost:8080}"
ADMIN_EMAIL="${MF_SMOKE_ADMIN_EMAIL:-demo-admin@example.invalid}"
ADMIN_PASSWORD="${MF_SMOKE_ADMIN_PASSWORD:-foundry-demo}"
SERVICE_TOKEN="${MF_SERVICE_TOKEN:-<redacted>}"
JAR_ADMIN="$(mktemp)"; JAR_VIEWER="$(mktemp)"
trap 'rm -f "$JAR_ADMIN" "$JAR_VIEWER"' EXIT

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1${2:+ — $2}"; }
# assert <name> <expected-status> <curl args...>  (captures body to $BODY)
BODY=""
assert() {
  local name="$1" want="$2"; shift 2
  local out; out="$(curl -sS -w '\n%{http_code}' "$@")"
  BODY="${out%$'\n'*}"; local code="${out##*$'\n'}"
  if [[ "$code" == "$want" ]]; then ok "$name"; else bad "$name" "want $want got $code: ${BODY:0:160}"; fi
}
jqp() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const v=JSON.parse(d);const r=eval("v."+process.argv[1]);console.log(typeof r==="object"?JSON.stringify(r):r)}catch{console.log("")}})' "$1" <<<"$BODY" | tr -d '\r'; }

echo "== MiniFoundry smoke against $BASE =="

echo "-- platform --"
assert "gateway healthz"            200 "$BASE/healthz"
assert "GET /api hello"             200 "$BASE/api"
assert "health (platform metrics)"  200 "$BASE/api/health"

echo "-- auth --"
assert "login admin" 200 -c "$JAR_ADMIN" -H 'content-type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" "$BASE/api/auth/login"
assert "me authenticated" 200 -b "$JAR_ADMIN" "$BASE/api/auth/me"
[[ "$(jqp 'authenticated')" == "true" ]] && ok "me.authenticated=true" || bad "me.authenticated" "$BODY"
assert "session shape" 200 -b "$JAR_ADMIN" "$BASE/api/session"
assert "users list (admin)" 200 -b "$JAR_ADMIN" "$BASE/api/users"
assert "login viewer" 200 -c "$JAR_VIEWER" -H 'content-type: application/json' \
  -d '{"email":"demo-viewer@example.invalid","password":"<redacted>"}' "$BASE/api/auth/login"
assert "users list forbidden (viewer)" 403 -b "$JAR_VIEWER" "$BASE/api/users"
[[ "$BODY" == *'requires admin role (current: viewer)'* ]] && ok "403 exact legacy message" || bad "403 message" "$BODY"

echo "-- seed --"
assert "POST /api/seed" 200 -b "$JAR_ADMIN" -X POST -H 'content-type: application/json' -d '{}' "$BASE/api/seed"
assert "POST /api/ontology/seed-demo" 200 -b "$JAR_ADMIN" -X POST -H 'content-type: application/json' -d '{}' "$BASE/api/ontology/seed-demo"
assert "POST /api/transforms/seed-demo" 200 -b "$JAR_ADMIN" -X POST -H 'content-type: application/json' -d '{}' "$BASE/api/transforms/seed-demo"
assert "POST /api/governance/seed-demo" 200 -b "$JAR_ADMIN" -X POST -H 'content-type: application/json' -d '{}' "$BASE/api/governance/seed-demo"

echo "-- catalog --"
assert "datasets list" 200 -b "$JAR_ADMIN" "$BASE/api/datasets"
DS_ID="$(jqp 'datasets[0].id')"
[[ -n "$DS_ID" && "$DS_ID" != "undefined" ]] && ok "dataset id resolved ($DS_ID)" || bad "dataset id" "$BODY"
assert "dataset detail" 200 -b "$JAR_ADMIN" "$BASE/api/datasets/$DS_ID"
assert "dataset rows paged" 200 -b "$JAR_ADMIN" "$BASE/api/datasets/$DS_ID/rows?limit=5&offset=0"
assert "dataset export csv" 200 -b "$JAR_ADMIN" "$BASE/api/datasets/$DS_ID/export?format=csv"
assert "dataset diff v1..v1" 200 -b "$JAR_ADMIN" "$BASE/api/datasets/$DS_ID/diff?from=1&to=1"
assert "branches list" 200 -b "$JAR_ADMIN" "$BASE/api/datasets/$DS_ID/branches"
assert "create branch" 201 -b "$JAR_ADMIN" -X POST -H 'content-type: application/json' \
  -d '{"name":"smoke-branch","baseVersion":1}' "$BASE/api/datasets/$DS_ID/branches"
BR_ID="$(jqp 'id')"
assert "delete branch" 200 -b "$JAR_ADMIN" -X DELETE "$BASE/api/datasets/$DS_ID/branches/$BR_ID"
assert "quality rules list" 200 -b "$JAR_ADMIN" "$BASE/api/datasets/$DS_ID/quality"
assert "quality evaluate" 200 -b "$JAR_ADMIN" -X POST "$BASE/api/datasets/$DS_ID/quality/evaluate"
assert "comments list" 200 -b "$JAR_ADMIN" "$BASE/api/datasets/$DS_ID/comments"
assert "watch status" 200 -b "$JAR_ADMIN" "$BASE/api/datasets/$DS_ID/watch"
assert "lineage graph" 200 -b "$JAR_ADMIN" "$BASE/api/lineage"
assert "projects list" 200 -b "$JAR_ADMIN" "$BASE/api/projects"
assert "connectors list" 200 -b "$JAR_ADMIN" "$BASE/api/connectors"
assert "ingestions list" 200 -b "$JAR_ADMIN" "$BASE/api/ingestions"
# CSV upload → new dataset (legacy ingest contract: type raw|sample|url)
assert "ingest raw csv dataset" 200 -b "$JAR_ADMIN" -X POST -H 'content-type: application/json' \
  -d "{\"type\":\"raw\",\"datasetName\":\"smoke-uploads-$(date +%s)\",\"raw\":\"id,name\n1,alpha\n2,beta\"}" "$BASE/api/ingest"

echo "-- orchestration --"
assert "pipelines list" 200 -b "$JAR_ADMIN" "$BASE/api/pipelines"
PL_ID="$(jqp 'pipelines[0].id')"
if [[ -n "$PL_ID" && "$PL_ID" != "undefined" ]]; then
  assert "pipeline detail" 200 -b "$JAR_ADMIN" "$BASE/api/pipelines/$PL_ID"
  assert "pipeline versions" 200 -b "$JAR_ADMIN" "$BASE/api/pipelines/$PL_ID/versions"
  assert "run pipeline (queued 202)" 202 -b "$JAR_ADMIN" -X POST "$BASE/api/pipelines/$PL_ID/run"
  JOB_ID="$(jqp 'job.id')"
  [[ -n "$JOB_ID" ]] && ok "job enqueued ($JOB_ID)" || bad "job id" "$BODY"
  # wait for the job to settle (worker lease + engine; legacy vocabulary:
  # execution_jobs use 'succeeded'/'failed', pipeline_runs use 'success')
  st=""
  for i in $(seq 1 30); do
    sleep 2
    assert "job status poll" 200 -b "$JAR_ADMIN" "$BASE/api/execution-jobs/$JOB_ID"
    st="$(jqp 'job.status')"
    [[ "$st" == "succeeded" || "$st" == "failed" ]] && break
  done
  [[ "$st" == "succeeded" ]] && ok "pipeline job succeeded" || bad "pipeline job status" "$st"
  assert "runs list" 200 -b "$JAR_ADMIN" "$BASE/api/runs?pipelineId=$PL_ID"
  RUN_ID="$(jqp 'runs[0].id')"
  if [[ -n "$RUN_ID" && "$RUN_ID" != "undefined" ]]; then
    assert "run detail (manifest)" 200 -b "$JAR_ADMIN" "$BASE/api/runs/$RUN_ID"
    assert "run output rows" 200 -b "$JAR_ADMIN" "$BASE/api/pipelines/$PL_ID/runs/$RUN_ID/output"
    assert "replay run" 200 -b "$JAR_ADMIN" -X POST "$BASE/api/runs/$RUN_ID/replay"
  fi
else
  bad "no seeded pipeline to exercise"
fi
assert "schedules list" 200 -b "$JAR_ADMIN" "$BASE/api/schedules"
assert "schedules due (service token)" 200 -H "x-service-token: $SERVICE_TOKEN" "$BASE/api/schedules/due"
assert "execution-jobs list" 200 -b "$JAR_ADMIN" "$BASE/api/execution-jobs"

echo "-- compute (transforms: SQL / JS / Python) --"
assert "transforms list" 200 -b "$JAR_ADMIN" "$BASE/api/transforms"
# SQL workbooks materialize inputs as tables named after the SANITIZED dataset
# name — use the seeded Shipments dataset and table 'shipments'.
assert "datasets for transforms" 200 -b "$JAR_ADMIN" "$BASE/api/datasets"
SHP_ID="$(node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d);const s=(v.datasets??[]).find(x=>x.name==="Shipments");console.log(s?s.id:"")})' <<<"$BODY" | tr -d '\r')"
[[ -n "$SHP_ID" ]] && ok "Shipments dataset resolved" || bad "Shipments dataset missing (seed?)"
mk_transform() { # <name> <language> <code-json-escaped>
  assert "create transform $1 ($2)" 201 -b "$JAR_ADMIN" -X POST -H 'content-type: application/json' \
    -d "{\"name\":\"$1\",\"language\":\"$2\",\"sourceCode\":$3,\"inputs\":[\"$SHP_ID\"],\"outputDatasetName\":\"$1-out\"}" \
    "$BASE/api/transforms"
  TR_ID="$(jqp 'transform.id')"
  assert "run transform $1" 200 -b "$JAR_ADMIN" -X POST "$BASE/api/transforms/$TR_ID/run"
  [[ "$(jqp 'run.status')" == "success" ]] && ok "transform $1 run success" || bad "transform $1 run" "$BODY"
  assert "transform $1 runs history" 200 -b "$JAR_ADMIN" "$BASE/api/transforms/$TR_ID/runs"
}
mk_transform "smoke-sql-$(date +%s)"  "sql"        '"SELECT * FROM shipments LIMIT 10"'
mk_transform "smoke-js-$(date +%s)"   "javascript" '"return input.rows.slice(0, 5);"'
mk_transform "smoke-py-$(date +%s)"   "python"     '"def transform(input):\n    return input[\"rows\"][:5]\n"'

echo "-- ontology --"
assert "ontology list" 200 -b "$JAR_ADMIN" "$BASE/api/ontology"
OT_API="$(jqp 'objectTypes[0].apiName')"
if [[ -n "$OT_API" && "$OT_API" != "undefined" ]]; then
  assert "objects list" 200 -b "$JAR_ADMIN" "$BASE/api/objects?type=$OT_API&limit=5"
  PK="$(jqp 'objects[0].pk')"
  if [[ -n "$PK" && "$PK" != "undefined" ]]; then
    assert "object detail" 200 -b "$JAR_ADMIN" "$BASE/api/objects/$OT_API/$PK"
  fi
  assert "object views" 200 -b "$JAR_ADMIN" "$BASE/api/objects/views?type=$OT_API"
fi
assert "actions list" 200 -b "$JAR_ADMIN" "$BASE/api/actions"
ACT_API="$(jqp 'actions[0].apiName')"
if [[ -n "$ACT_API" && "$ACT_API" != "undefined" ]]; then
  assert "action detail" 200 -b "$JAR_ADMIN" "$BASE/api/actions/$ACT_API"
fi
assert "action logs" 200 -b "$JAR_ADMIN" "$BASE/api/actions/logs"
assert "dashboards list" 200 -b "$JAR_ADMIN" "$BASE/api/dashboards"
assert "applications list" 200 -b "$JAR_ADMIN" "$BASE/api/applications"

echo "-- governance --"
assert "markings list" 200 -b "$JAR_ADMIN" "$BASE/api/markings"
assert "approvals list" 200 -b "$JAR_ADMIN" "$BASE/api/approvals"
assert "audit feed" 200 -b "$JAR_ADMIN" "$BASE/api/audit"
assert "acl list (dataset)" 200 -b "$JAR_ADMIN" "$BASE/api/acl?resourceType=dataset&resourceId=$DS_ID"
assert "acl check" 200 -b "$JAR_ADMIN" "$BASE/api/acl/check?resourceType=dataset&resourceId=$DS_ID&email=$ADMIN_EMAIL"
assert "notifications" 200 -b "$JAR_ADMIN" "$BASE/api/notifications"
assert "curriculum status" 200 -b "$JAR_ADMIN" "$BASE/api/curriculum"
assert "settings overview" 200 -b "$JAR_ADMIN" "$BASE/api/settings/overview"
assert "search" 200 -b "$JAR_ADMIN" "$BASE/api/search?q=ship"
assert "stats" 200 -b "$JAR_ADMIN" "$BASE/api/stats"

echo "-- public API v1 (token auth + rate limits) --"
TOK_NAME="smoke-$(date +%s)"
assert "create api token" 201 -b "$JAR_ADMIN" -X POST -H 'content-type: application/json' \
  -d "{\"name\":\"$TOK_NAME\"}" "$BASE/api/tokens"
SECRET="$(jqp 'secret')"
assert "v1 whoami (bearer)" 200 -H "authorization: Bearer $SECRET" "$BASE/api/foundry/v1/whoami"
assert "v1 datasets" 200 -H "authorization: Bearer $SECRET" "$BASE/api/foundry/v1/datasets"
assert "v1 ontology" 200 -H "authorization: Bearer $SECRET" "$BASE/api/foundry/v1/ontology"
assert "v1 pipelines" 200 -H "authorization: Bearer $SECRET" "$BASE/api/foundry/v1/pipelines"
assert "v1 unauthorized" 401 -H "authorization: Bearer mf_live_bogus" "$BASE/api/foundry/v1/whoami"
# rate limit: 60/min per token — burn the window, expect 429 + headers
limited=0
for i in $(seq 1 65); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -H "authorization: Bearer $SECRET" "$BASE/api/foundry/v1/whoami")"
  [[ "$code" == "429" ]] && limited=1 && break
done
[[ "$limited" == "1" ]] && ok "v1 rate limit → 429 within window" || bad "v1 rate limit never hit 429"
rl_headers="$(curl -sS -D - -o /dev/null -H "authorization: Bearer $SECRET" "$BASE/api/foundry/v1/whoami")"
[[ "$rl_headers" == *'retry-after'* || "$rl_headers" == *'Retry-After'* ]] && ok "429 carries Retry-After" || bad "Retry-After header missing"
assert "usage dashboard" 200 -b "$JAR_ADMIN" "$BASE/api/tokens/usage"

echo "-- masking (governance across surfaces) --"
# attach a viewer-invisible marking to a dataset column, then verify the
# viewer sees the mask literal where the admin sees the real value.
assert "markings after seed" 200 -b "$JAR_ADMIN" "$BASE/api/markings"
MK_ID="$(jqp 'markings[0].id')"
COL="$(curl -sS -b "$JAR_ADMIN" "$BASE/api/datasets/$DS_ID/rows?limit=1" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const v=JSON.parse(d);console.log(Object.keys(v.rows[0]??{})[0]??"")}catch{console.log("")}})')"
if [[ -n "$MK_ID" && "$MK_ID" != "undefined" && -n "$COL" ]]; then
  assert "attach marking to column" 200 -b "$JAR_ADMIN" -X POST -H 'content-type: application/json' \
    -d "{\"datasetId\":\"$DS_ID\",\"columns\":[\"$COL\"]}" "$BASE/api/markings/$MK_ID/attach"
  admin_val="$(curl -sS -b "$JAR_ADMIN" "$BASE/api/datasets/$DS_ID/rows?limit=1" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d);console.log(v.rows[0][process.argv[1]]??"")})' "$COL")"
  viewer_val="$(curl -sS -b "$JAR_VIEWER" "$BASE/api/datasets/$DS_ID/rows?limit=1" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d);console.log(v.rows[0][process.argv[1]]??"")})' "$COL")"
  if [[ "$viewer_val" == "------" && "$admin_val" != "------" ]]; then
    ok "column masking: admin sees value, viewer sees ------"
  else
    bad "column masking" "admin='$admin_val' viewer='$viewer_val' (marking minRole may allow viewer)"
  fi
  assert "detach marking" 200 -b "$JAR_ADMIN" -X POST -H 'content-type: application/json' \
    -d "{\"datasetId\":\"$DS_ID\",\"columns\":[\"$COL\"]}" "$BASE/api/markings/$MK_ID/detach"
fi

echo "-- SPA --"
spa_code="$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/)"
[[ "$spa_code" == "200" ]] && ok "frontend serves SPA at :3000" || bad "frontend :3000" "HTTP $spa_code"

echo ""
echo "== smoke result: $PASS passed, $FAIL failed =="
[[ "$FAIL" == "0" ]] || exit 1
