#!/usr/bin/env bash
# Red team against the agent shell. Run as the runner user after
# bin/agent-shell.sh, with the private key whose public line went in:
#   bin/agent-shell-check.sh <private key file>
# Every line says ok or FAIL; the exit code is 1 when any check failed.
set -uo pipefail

DIR="${AGENT_SHELL_DIR:-$HOME/.agent-shell}"
KEY="${1:-}"
PROXY_PORT="${AGENT_SHELL_PROXY_PORT:-3128}"
SSHD_DIR=/etc/ssh/agent-shell
BAD=0
pass() { printf 'ok    %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1" >&2; BAD=1; }
refused() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then fail "$name"; else pass "$name"; fi; }
worked() {
  local name="$1" output
  shift
  if output=$("$@" 2>&1); then pass "$name"; else fail "$name"; printf '%s\n' "$output" | tail -5 | sed 's/^/      /' >&2; fi
}
as_agent() { sudo -u agent env HOME=/home/agent "$@"; }
login_agent() { sudo -u agent -i "$@"; }

[ -n "$KEY" ] || { echo "usage: $0 <private key file>" >&2; exit 2; }

# 1. No sudo, and no way to get it.
case " $(id -nG agent) " in
  *" sudo "*) fail "agent is not in the sudo group" ;;
  *) pass "agent is not in the sudo group" ;;
esac
refused "agent cannot run sudo" sudo -u agent sudo -n true
refused "no sudoers rule names agent" sudo grep -rqsE '^[^#%]*\bagent\b' /etc/sudoers /etc/sudoers.d

# 2. Between the worker and the agent: /proc, the host private key, the ticket.
env WORKER_TOKEN=canary-sentinel-9182 sleep 60 &
CANARY=$!
trap 'kill "$CANARY" 2>/dev/null' EXIT
worked "the worker's own environment is readable by its user" grep -q canary-sentinel-9182 "/proc/$CANARY/environ"
refused "agent cannot read /proc/<worker pid>/environ" as_agent cat "/proc/$CANARY/environ"
worked "the host private key is root-only" sudo test "$(sudo stat -c %a "$SSHD_DIR/ssh_host_ed25519_key")" = 600
refused "agent cannot read the host private key" as_agent cat "$SSHD_DIR/ssh_host_ed25519_key"
worked "the ticket file is the runner user's own" test "$(stat -c '%a %U' "$DIR/ticket")" = "600 $(id -un)"
refused "agent cannot read the ticket file" as_agent cat "$DIR/ticket"

# 3. Egress: nothing direct, nothing outside the list through the proxy, GitHub and npm yes.
refused "agent cannot reach example.com directly" as_agent env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy curl -sS -m 15 -o /dev/null https://example.com
refused "agent cannot reach example.com through the proxy" as_agent env HTTPS_PROXY="http://127.0.0.1:$PROXY_PORT" curl -sS -m 15 -o /dev/null https://example.com
worked "agent fetches FloCafe tags from github.com through the proxy" login_agent git -C /home/agent/flocafe fetch --quiet --tags --prune origin
worked "agent asks the npm registry through the proxy" login_agent npm view typescript version
worked "agent has ripgrep" as_agent rg --version

# 4. The way in: key auth only, the right key works, a wrong one does not.
SSH_OPTIONS=(-o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$DIR/known_hosts")
worked "sshd listens on loopback only" test -z "$(ss -ltnH 'sport = :22' | grep '0.0.0.0:22\|\*:22')"
worked "ssh with the key reaches the agent shell as agent" ssh -i "$KEY" "${SSH_OPTIONS[@]}" agent@127.0.0.1 'test "$(id -un)" = agent && test "$PWD" = /home/agent'
wrong=$(mktemp)
ssh-keygen -q -t ed25519 -N "" -f "$wrong" >/dev/null
refused "ssh with a wrong key is refused" ssh -i "$wrong" "${SSH_OPTIONS[@]}" agent@127.0.0.1 true
rm -f "$wrong" "$wrong.pub"

[ "$BAD" = 0 ] && echo "the agent shell passed every check" || echo "the agent shell failed a check" >&2
exit "$BAD"
