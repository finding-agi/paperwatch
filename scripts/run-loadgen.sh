#!/bin/sh
# Run one load-test scenario on Railway's lt-gen service (loadtest environment only), e.g.
#   sh scripts/run-loadgen.sh orders LG_N=2000 LG_C=200
# The service runs scripts/loadgen.ts once and stops (restart policy NEVER); read results with
#   railway logs --service lt-gen --environment loadtest
set -eu
cd "$(dirname "$0")/.."
scenario="$1"; shift
stage=".deploy-loadgen"
rm -rf "$stage" && mkdir "$stage"
trap 'rm -rf "$stage"' EXIT
cp -R package.json package-lock.json src scripts "$stage/"
sed -e 's|^CMD .*|COPY scripts ./scripts\nCMD ["node", "scripts/loadgen.ts"]|' Dockerfile > "$stage/Dockerfile"
printf '{"build":{"builder":"DOCKERFILE","dockerfilePath":"Dockerfile"},"deploy":{"restartPolicyType":"NEVER"}}\n' > "$stage/railway.json"
sets="--set LG_SCENARIO=$scenario --set LG_TARGET=https://lt-web-loadtest.up.railway.app"
for kv in "$@"; do sets="$sets --set $kv"; done
railway variables --service lt-gen --environment loadtest --skip-deploys $sets >/dev/null
(cd "$stage" && railway up --no-gitignore --project aa5097cb-ba1e-49bc-ab91-55b39ce7b91d --environment loadtest --service lt-gen --ci | tail -1)
