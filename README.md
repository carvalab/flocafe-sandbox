# flocafe-sandbox

The container image used to run [FloCafe](https://github.com/FreeOpenSourcePOS/FloCafe) for reproduction. It holds a browser and the tools to build one FloCafe version. It holds no accounts, no tokens and no data.

## Build

```bash
docker build -t flocafe-sandbox:3 .
```

## Run one version

`REF` is a branch or tag of `FreeOpenSourcePOS/FloCafe`, for example `3.13.0`.

```bash
docker run -d --name demo -p 127.0.0.1:9222:9222 flocafe-sandbox:3 sleep infinity
docker exec demo build-flocafe.sh "$REF"     # clones, installs, builds; about 70 s
docker exec demo start-flocafe.sh            # serves on 127.0.0.1:3101 inside the container
docker exec demo start-browser.sh            # headless Chromium, CDP on 127.0.0.1:9222
docker rm -f demo
```

## What is inside

| File | Does |
|---|---|
| `Dockerfile` | `mcr.microsoft.com/playwright` plus `build-essential` and `python3` (better-sqlite3 compiles from source) |
| `bin/build-flocafe.sh` | Shallow-clones one ref and builds the frontend and backend |
| `bin/start-flocafe.sh` | Starts that version's demo server on port 3101 |
| `bin/start-browser.sh` | Starts headless Chromium |
| `bin/cdp-proxy.cjs` | Forwards `0.0.0.0:9222` to Chrome, which only listens on `127.0.0.1` |
| `bin/fake-printer.cjs` | Listens on port 9100 and writes whatever it receives to `/tmp` |

## Check

`.github/workflows/check.yml` builds the image on every push and runs FloCafe `3.13.0` and then `main` in a container, confirming each one serves. The built image is cached, so a repeat run skips the build. The job needs no secrets.
