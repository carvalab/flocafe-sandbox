# flocafe-sandbox

The microVM image used to run [FloCafe](https://github.com/FreeOpenSourcePOS/FloCafe) for reproduction. It holds a browser and the tools to build one FloCafe version. It holds no accounts, no tokens and no data.

Built on [microsandbox](https://microsandbox.dev) (`msb`), which runs each sandbox as its own small virtual machine on KVM.

## Build

```bash
docker build -t flocafe-sandbox:3 .
docker save flocafe-sandbox:3 | msb load
```

## Run one version

`REF` is a branch or tag of `FreeOpenSourcePOS/FloCafe`, for example `3.13.0`.

```bash
msb create -n demo -c 4 -m 6G flocafe-sandbox:3
msb exec demo -- build-flocafe.sh "$REF"     # clones, installs, builds; about 70 s
msb exec demo -- start-flocafe.sh            # serves on 127.0.0.1:3101 inside the VM
msb exec demo -- start-browser.sh            # headless Chromium, CDP on 127.0.0.1:9222
msb rm -f demo
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

`.github/workflows/microvm.yml` builds the image and boots one microVM on every push. GitHub's Ubuntu runners expose KVM, so the job needs no extra hardware and no secrets.
