# flocafe-sandbox

Runs [FloCafe](https://github.com/FreeOpenSourcePOS/FloCafe) for bug reproduction on GitHub's hosted runners. The FloCafe support bot's control center starts one `session` job per sandbox; the job builds the asked FloCafe version, starts it with a headless Chrome, and lets the control center drive both over [iroh](https://iroh.computer). No image: the runner already has Node, git, the build tools and Chrome.

The repo holds no accounts and no data. Its one secret, `WORKER_TOKEN`, proves a runner to the control center; pull requests from forks cannot read it, and only people with write access can start a session.

## How a session runs

1. The control center starts `session.yml` with `workflow_dispatch`, passing its iroh ticket.
2. `worker/main.ts` makes a fresh iroh key, connects to the control center and says hello with `WORKER_TOKEN`.
3. For each `start(ref)` it runs `bin/build-flocafe.sh` (about 85 s), `bin/start-flocafe.sh` (port 3101) and `bin/start-browser.sh` (CDP on 9222). A start for another ref rebuilds in place on the same runner; the same ref again reuses the build.
4. The control center runs commands, reads files and drives Chrome over CDP through the worker.
5. The job ends when the connection drops or after 15 minutes with no session. A session lasts at most an hour, and an open agent shell keeps the job up while nothing else is running.

## The agent shell (optional)

With the `ssh_key` input set, `bin/agent-shell.sh` adds a second user before the worker starts. The control center asks for it with the `shell` RPC and gets `{ ticket, hostKey, user, home, repo }`, or `{ ok: false, error: "no shell" }` when the input was empty.

| What | Where |
|---|---|
| user `agent`, no sudo, no sudoers rule | `/home/agent` |
| sshd, new ed25519 host key per job, key auth only, `AllowUsers agent`, no forwarding, no password | `127.0.0.1:22`, `/etc/ssh/agent-shell/` |
| the tunnel, pinned by version and SHA-256 | `dumbpipe 0.40.1`, ticket in `~/.agent-shell/ticket`, mode 0600 |
| the host public key line for the control center to pin | `~/.agent-shell/host_key.pub` |
| egress for uid `agent`: loopback, DNS, an allowlist proxy, nothing else | proxy on `127.0.0.1:3128`, host list in `bin/allowlist-proxy.cjs` |
| `HTTP_PROXY` and `HTTPS_PROXY` for agent's login | `/etc/profile.d/agent-shell-proxy.sh` |
| full FloCafe clone, all tags, owned by `agent` | `/home/agent/flocafe` |
| red team script, run as the runner user | `bin/agent-shell-check.sh <private key>` |

`~/.agent-shell/` is mode 0700 and the ticket is 0600, so uid `agent` cannot read them. The ticket and every private key stay out of the job log: dumbpipe's stderr goes to a 0600 file that is deleted as soon as the ticket is out of it. `.github/workflows/check.yml` sets the shell up on every push and runs the red team script against it: no sudo, no `/proc/<worker pid>/environ`, no host private key, no ticket, no direct egress, no egress outside the proxy list, and key auth works only with the right key.

## Files

| File | Does |
|---|---|
| `worker/main.ts` | The iroh worker: hello, then `start`, `exec`, `readFile`, `stop` and the CDP stream |
| `worker/sandboxes.ts` | Builds, starts and stops one FloCafe version at a time |
| `bin/build-flocafe.sh` | Shallow-clones one ref into `/work/flocafe` and builds the frontend and backend |
| `bin/start-flocafe.sh` | Starts that version's demo server on port 3101 |
| `bin/start-browser.sh` | Starts headless Chrome and the CDP proxy |
| `bin/cdp-proxy.cjs` | Forwards `0.0.0.0:9222` to Chrome, which only listens on `127.0.0.1` |
| `bin/fake-printer.cjs` | Listens on port 9100 and writes whatever it receives to `/tmp` |
| `bin/agent-shell.sh` | Builds the optional agent shell: user `agent`, sshd, tunnel, egress allowlist, clone |
| `bin/agent-shell-check.sh` | Red team script for that shell; CI runs it after the setup |
| `bin/allowlist-proxy.cjs` | The HTTP(S) proxy that is uid `agent`'s only way out |

## Check

`.github/workflows/check.yml` runs the worker's tests, then builds FloCafe `3.13.0` and `main` on the runner and confirms each serves, on every push.

## Run it on your machine (development)

```bash
npm ci
sudo install -d -o "$USER" /work
CONTROL_TICKET=<ticket from the control center's /api/status> WORKER_TOKEN=<token> node worker/main.ts
```

## What commands can see

Everything the worker starts (commands from the control center, the FloCafe build, the app, Chrome) gets a clean environment: every variable whose name looks like a secret (`TOKEN`, `SECRET`, `PASSWORD`, `TICKET`, `CREDENTIAL`, `API_KEY`, `..._KEY`) is removed (`cleanEnv` in `worker/sandboxes.ts`), and the worker deletes `WORKER_TOKEN` and `CONTROL_TICKET` from its own environment after reading them. So `env`, `printenv` and `echo $WORKER_TOKEN` show nothing.

This is not a wall. The worker and the commands run as the same user, and the runner's initial environment block of the worker is still readable at `/proc/<worker pid>/environ`. The control center flags a command that reads it. The stronger fix, if the investigator ever gets more power: run commands as another user. That is now built, as the optional agent shell: the open agent works as `agent`, while the worker, its token, the tunnel and sshd's host key stay with the runner user, which `agent` cannot read, signal or trace. Everything the worker still starts stays in the old shared-user case above.

With the shell, uid `agent` also has no way out except an allowlist proxy on loopback (GitHub and the npm registry), so text it reads cannot be sent anywhere else. See "The agent shell".

