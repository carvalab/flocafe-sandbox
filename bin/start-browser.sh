#!/bin/sh
set -e
CHROME=$(ls -d /ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64)/chrome-headless-shell
setsid node /opt/flocafe-sandbox/cdp-proxy.cjs >/tmp/cdp-proxy.log 2>&1 </dev/null &
setsid "$CHROME" --no-sandbox --remote-debugging-port=9221 --user-data-dir=/tmp/chrome-profile about:blank >/tmp/chrome.log 2>&1 </dev/null &
for i in $(seq 1 20); do curl -s -o /dev/null http://127.0.0.1:9221/json/version && exit 0; sleep 0.5; done
echo "chrome did not start" >&2; exit 1
