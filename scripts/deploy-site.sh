#!/bin/sh
# Deploy paperwatch.app's services (queue-view = web, paperwatch-worker = worker) with railway.web.json as their config:
# it adds the /healthz health check, so Railway keeps the running version until the new one answers. Every `railway up`
# from the repo root applies the root railway.json (which the bot needs and which has no health check) and resets the
# dashboard's config-file path, so these two deploy from a staging copy where railway.web.json is the railway.json.
#   npm run deploy:site -- worker | web | both
set -eu
cd "$(dirname "$0")/.."
which="${1:-both}"
# Inside the repo (railway up only deploys folders under the linked one), gitignored, cleared each run.
stage=".deploy-site"
rm -rf "$stage" && mkdir "$stage"
trap 'rm -rf "$stage"' EXIT
cp -R Dockerfile package.json package-lock.json src "$stage/"
cp railway.web.json "$stage/railway.json"
project="aa5097cb-ba1e-49bc-ab91-55b39ce7b91d"
deploy() { (cd "$stage" && railway up --no-gitignore --project "$project" --environment production --service "$1" --ci | tail -1); }
case "$which" in
  worker) deploy paperwatch-worker ;;
  web) deploy queue-view ;;
  both) deploy paperwatch-worker && deploy queue-view ;;
  *) echo "usage: npm run deploy:site -- worker | web | both" >&2; exit 1 ;;
esac
