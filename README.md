# flocafe-sandbox

Runs [FloCafe](https://github.com/FreeOpenSourcePOS/FloCafe) for bug reproduction on GitHub's hosted runners. The FloCafe support bot's control center starts one `session` job per sandbox; the job builds the asked FloCafe version, starts it with a headless Chrome, and lets the control center drive both over [iroh](https://iroh.computer). No image: the runner already has Node, git, the build tools and Chrome.

The repo holds no accounts and no data. Its one secret, `WORKER_TOKEN`, proves a runner to the control center; pull requests from forks cannot read it, and only people with write access can start a session.

## How a session runs

1. The control center starts `session.yml` with `workflow_dispatch`, passing its iroh ticket.
2. `worker/main.ts` makes a fresh iroh key, connects to the control center and says hello with `WORKER_TOKEN`.
3. For each `start(ref)` it runs `bin/build-flocafe.sh` (about 85 s), `bin/start-flocafe.sh` (port 3101) and `bin/start-browser.sh` (CDP on 9222). A start for another ref rebuilds in place on the same runner; the same ref again reuses the build.
4. The control center runs commands, reads files and drives Chrome over CDP through the worker.
5. The job ends when the connection drops or after 15 minutes with no session. A session lasts at most an hour.

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

This is not a wall. The worker and the commands run as the same user, and the runner's initial environment block of the worker is still readable at `/proc/<worker pid>/environ`. The control center flags a command that reads it. The stronger fixes, if the investigator ever gets more power: run commands as another user, or replace the shared `WORKER_TOKEN` with the job's own short-lived GitHub token.

