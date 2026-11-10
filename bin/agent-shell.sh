#!/usr/bin/env bash
# Sets up the agent shell on a fresh runner: the user agent (no sudo), an sshd
# on 127.0.0.1:22 that allows only agent by key, the dumbpipe tunnel to it, the
# egress allowlist and the full FloCafe clone. Idempotent, so a second run
# repairs rather than duplicates. Run as the runner user; it never prints the
# ticket, a private key or dumbpipe's output.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
KEY="${1:-${AGENT_SHELL_PUBKEY:-}}"
DIR="${AGENT_SHELL_DIR:-$HOME/.agent-shell}"
PROXY_PORT="${AGENT_SHELL_PROXY_PORT:-3128}"
SSHD_DIR=/etc/ssh/agent-shell
AGENT_HOME=/home/agent
REPO=$AGENT_HOME/flocafe
DUMBPIPE=0.40.1
DUMBPIPE_SHA256=66aee1e249890ee63678dfc8f18ce3671e691673c83bbd72bf9a54c4d32da85c

case "$KEY" in
  "ssh-ed25519 "* | "ssh-rsa "* | "ecdsa-sha2-nistp256 "* | "ecdsa-sha2-nistp384 "* | "ecdsa-sha2-nistp521 "* | "sk-ssh-ed25519@openssh.com "* | "sk-ecdsa-sha2-nistp256@openssh.com "*) ;;
  *) echo "usage: AGENT_SHELL_PUBKEY='<one OpenSSH public key line>' $0" >&2; exit 2 ;;
esac
case "$KEY" in *$'\n'*) echo "the key must be one line" >&2; exit 2 ;; esac

listening() {
  local found
  for _ in $(seq 1 40); do
    found=$(ss -ltnH "sport = :$1")
    [ -n "$found" ] && return 0
    sleep 0.5
  done
  return 1
}

mkdir -p "$DIR"
chmod 700 "$DIR"

# 1. The user agent: no sudo group, no sudoers rule, home of its own.
if ! id agent >/dev/null 2>&1; then
  sudo useradd --create-home --shell /bin/bash --user-group agent
fi
# useradd leaves the account locked ("!"), and sshd without PAM refuses a key for a locked account; "*" is no password, not locked.
sudo usermod -p '*' agent
sudo install -d -o agent -g agent -m 0700 "$AGENT_HOME/.ssh"
# Root owns the directory and the file, so agent can read them but cannot add a key of its own.
printf '%s\n' "$KEY" | sudo tee "$AGENT_HOME/.ssh/authorized_keys" >/dev/null
sudo chown root:root "$AGENT_HOME/.ssh" "$AGENT_HOME/.ssh/authorized_keys"
sudo chmod 0755 "$AGENT_HOME/.ssh"
sudo chmod 0644 "$AGENT_HOME/.ssh/authorized_keys"

# 2. sshd, with a host key made in this job, on loopback only.
if ! command -v sshd >/dev/null 2>&1 || ! command -v rg >/dev/null 2>&1; then
  sudo apt-get -o Acquire::http::Timeout=30 -o Acquire::Retries=2 update -qq
  command -v sshd >/dev/null 2>&1 || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server
  command -v rg >/dev/null 2>&1 || sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ripgrep
fi
sudo systemctl disable --now ssh.service ssh.socket >/dev/null 2>&1 || true
sudo systemctl mask ssh.service ssh.socket >/dev/null 2>&1 || true
sudo install -d -m 0755 "$SSHD_DIR" /run/sshd
if [ ! -f "$SSHD_DIR/ssh_host_ed25519_key" ]; then
  sudo ssh-keygen -q -t ed25519 -N "" -C agent-shell -f "$SSHD_DIR/ssh_host_ed25519_key"
fi
sudo chmod 0600 "$SSHD_DIR/ssh_host_ed25519_key"
sudo chmod 0644 "$SSHD_DIR/ssh_host_ed25519_key.pub"
sudo tee "$SSHD_DIR/sshd_config" >/dev/null <<'CONF'
Port 22
ListenAddress 127.0.0.1
HostKey /etc/ssh/agent-shell/ssh_host_ed25519_key
PidFile /run/agent-shell-sshd.pid
AuthorizedKeysFile .ssh/authorized_keys
AllowUsers agent
PermitRootLogin no
PubkeyAuthentication yes
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
UsePAM no
AllowAgentForwarding no
AllowTcpForwarding no
PermitOpen none
X11Forwarding no
PermitTunnel no
GatewayPorts no
PermitUserEnvironment no
MaxAuthTries 3
StrictModes yes
LogLevel VERBOSE
CONF
if ! sudo test -s /run/agent-shell-sshd.pid || ! sudo kill -0 "$(sudo cat /run/agent-shell-sshd.pid)" 2>/dev/null; then
  sudo /usr/sbin/sshd -f "$SSHD_DIR/sshd_config"
fi
listening 22 || { echo "sshd did not listen on 127.0.0.1:22" >&2; exit 1; }
# The worker pins this public key; the private one stays root-only in sshd's folder.
cp "$SSHD_DIR/ssh_host_ed25519_key.pub" "$DIR/host_key.pub"

# 3. The full clone the agent works in, with every tag, owned by agent.
echo "agent shell: the sshd is up, cloning FloCafe"
if [ ! -d "$REPO/.git" ]; then
  # -C because git reads its working directory first, and agent cannot enter the runner's workspace.
  sudo -H -u agent git -C "$AGENT_HOME" clone --quiet https://github.com/FreeOpenSourcePOS/FloCafe "$REPO"
fi
sudo -H -u agent git -C "$REPO" fetch --quiet --tags --prune origin
sudo chown -R agent:agent "$REPO"

echo "agent shell: cloned, starting the tunnel"
# 4. The tunnel, pinned by version and hash. Its stderr holds a secret key, so
#    it goes to a 0600 file that is deleted as soon as the ticket is out of it.
mkdir -p "$DIR/bin"
if ! "$DIR/bin/dumbpipe" --version 2>/dev/null | grep -qx "dumbpipe $DUMBPIPE"; then
  work=$(mktemp -d)
  curl -fsSL -o "$work/dumbpipe.tar.gz" "https://github.com/n0-computer/dumbpipe/releases/download/v$DUMBPIPE/dumbpipe-v$DUMBPIPE-linux-x86_64.tar.gz"
  echo "$DUMBPIPE_SHA256  $work/dumbpipe.tar.gz" | sha256sum -c --status
  tar -xzf "$work/dumbpipe.tar.gz" -C "$work"
  install -m 0755 "$work/dumbpipe" "$DIR/bin/dumbpipe"
  rm -rf "$work"
fi
if ! [ -s "$DIR/dumbpipe.pid" ] || ! kill -0 "$(cat "$DIR/dumbpipe.pid")" 2>/dev/null; then
  rm -f "$DIR/ticket" "$DIR/ticket.log"
  (umask 077 && nohup "$DIR/bin/dumbpipe" listen-tcp --host 127.0.0.1:22 >/dev/null 2>"$DIR/ticket.log" & echo $! >"$DIR/dumbpipe.pid")
  for _ in $(seq 1 40); do grep -q 'connect-tcp' "$DIR/ticket.log" 2>/dev/null && break; sleep 0.5; done
  ticket=$(grep -oE 'endpoint[0-9a-z]+' "$DIR/ticket.log" | tail -1)
  [ -n "$ticket" ] || { echo "dumbpipe printed no ticket" >&2; exit 1; }
  (umask 077 && printf '%s\n' "$ticket" >"$DIR/ticket")
  rm -f "$DIR/ticket.log"
fi

echo "agent shell: the tunnel is up, starting the proxy and the egress rules"
# 5. The allowlist proxy, then egress for uid agent: loopback, DNS, the proxy, nothing else.
if ! ss -ltnH "sport = :$PROXY_PORT" | grep -q .; then
  AGENT_SHELL_PROXY_PORT=$PROXY_PORT nohup node "$HERE/allowlist-proxy.cjs" >>"$DIR/proxy.log" 2>&1 &
fi
listening "$PROXY_PORT" || { echo "the allowlist proxy did not start" >&2; exit 1; }
printf 'export HTTP_PROXY=http://127.0.0.1:%s\nexport HTTPS_PROXY=http://127.0.0.1:%s\nexport http_proxy=$HTTP_PROXY\nexport https_proxy=$HTTPS_PROXY\nexport NO_PROXY=127.0.0.1,localhost\nexport no_proxy=$NO_PROXY\n' "$PROXY_PORT" "$PROXY_PORT" | sudo tee /etc/profile.d/agent-shell-proxy.sh >/dev/null
uid=$(id -u agent)
for table in iptables ip6tables; do
  sudo "$table" -L OUTPUT >/dev/null 2>&1 || continue
  while sudo "$table" -D OUTPUT -m owner --uid-owner "$uid" -o lo -j ACCEPT 2>/dev/null; do :; done
  while sudo "$table" -D OUTPUT -m owner --uid-owner "$uid" -p udp --dport 53 -j ACCEPT 2>/dev/null; do :; done
  while sudo "$table" -D OUTPUT -m owner --uid-owner "$uid" -p tcp --dport 53 -j ACCEPT 2>/dev/null; do :; done
  while sudo "$table" -D OUTPUT -m owner --uid-owner "$uid" -j REJECT 2>/dev/null; do :; done
  sudo "$table" -A OUTPUT -m owner --uid-owner "$uid" -o lo -j ACCEPT
  sudo "$table" -A OUTPUT -m owner --uid-owner "$uid" -p udp --dport 53 -j ACCEPT
  sudo "$table" -A OUTPUT -m owner --uid-owner "$uid" -p tcp --dport 53 -j ACCEPT
  sudo "$table" -A OUTPUT -m owner --uid-owner "$uid" -j REJECT
done

echo "agent shell ready"
