#!/bin/sh
set -e
cd /work/flocafe
if [ -f scripts/docs/demo-server.cjs ]; then
  setsid node scripts/docs/demo-server.cjs >/tmp/demo-server.log 2>&1 </dev/null &
  NOTE=""
elif [ -f tests/e2e-server.cjs ]; then
  E2E_TASK_LOCAL_PORTS=1 E2E_BASE_URL=http://127.0.0.1:3101 E2E_KDS_BASE_URL=http://127.0.0.1:3102 E2E_SERVER_APP_BASE_URL=http://127.0.0.1:3103 \
    setsid node tests/e2e-server.cjs >/tmp/demo-server.log 2>&1 </dev/null &
  NOTE="This version has no Blue Harbor demo; it runs upstream's own test server (tests/e2e-server.cjs) with a small fixture. Log in as owner@flo.local, manager@flo.local or server@flo.local, password E2ePass123!. The demo data in the guide does not exist here."
else
  echo "this version has neither scripts/docs/demo-server.cjs nor tests/e2e-server.cjs" >&2; exit 1
fi
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:3101/ && { echo "$NOTE"; exit 0; }; sleep 0.5; done
echo "demo server did not start" >&2; tail -20 /tmp/demo-server.log >&2; exit 1
