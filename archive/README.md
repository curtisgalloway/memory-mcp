<!--
SPDX-FileCopyrightText: 2026 Curtis Galloway
SPDX-License-Identifier: Apache-2.0
-->

# memory-archive: a full copy of your notes on a machine you own

memory-mcp keeps its notes as Markdown files in a git repository hosted by
Cloudflare. This directory is a small job that fetches that repository onto a
Linux machine you control every 15 minutes, so you always hold a complete copy
with every commit. If the hosted repository changes, breaks or disappears, the
copy can be pushed anywhere.

**Terms**

- **Artifacts repo** — a git repository hosted by Cloudflare's Artifacts
  service. memory-mcp stores your notes in one. See `GLOSSARY.md` in the
  repository root for the project's other terms.
- **Repo token** — a password for one Artifacts repo. A `read` token can clone
  and fetch but never push. Its text ends in `?expires=<unix time>`.
- **systemd timer** — a systemd unit that starts another unit (here, the
  fetch job) on a schedule. `systemctl list-timers` shows when it runs next.
- **Textfile metric** — a small text file of `name{labels} value` lines that a
  monitoring agent (for example Prometheus's node exporter) reads from a
  directory and publishes. Optional here.
- **Fast-forward** — moving a git branch to a newer commit that already
  contains the old one. The only move this job ever makes.

## What it does and guarantees

The job is one Python 3 file with no dependencies beyond the standard library
and `git`. Each run:

1. Reads the repo's https URL and the read-only repo token.
2. Fetches into `/var/lib/memory-archive/<repo name>/`, making the clone first
   if it is missing.
3. Moves the local `main` branch only by fast-forward. If the hosted `main`
   does not contain the archived `main` (history was rewritten, or the repo was
   replaced), the run fails with `step=diverged` and changes nothing: the
   archive keeps the old history. This is the point of an archive.
4. Saves what it knows (last success, token expiry, head commit time) in
   `/var/lib/memory-archive/.state/state.json`, and, if you configure a path,
   rewrites a textfile metric file from it, on success and on failure.
5. Prints one line, which lands in the journal:
   `memory-archive: ok repo=<name> head=<12 hex> changed=yes|no`, or
   `memory-archive: failed step=<step> repo=<name> <reason>`.

Guarantees:

- **The token is never written to disk by the job** (not into `.git/config`,
  not into a credential store) **and never appears on a command line.**
  systemd reads it from a root-only file and gives the job a copy on a
  memory-backed filesystem. The job passes it to the one `git fetch` process as
  an `Authorization` header through `GIT_CONFIG_*` environment variables.
  No credential helper runs, no prompt appears, no system or user git
  configuration is read, no hooks run, and redirects are not followed.
- **Refusals.** The remote must be https with no user name or password in it.
  A token with no `?expires=` time is refused, because without it the expiry
  warnings could never work.
- **Nothing private is printed.** Neither the token, the remote URL, note
  paths nor note text ever appear in the output.
- **A run cannot hang.** The whole run has a 240 second budget, and a watchdog
  records a failure and exits at 270 seconds, 30 seconds before systemd's own
  300 second limit would kill the job with nothing recorded.
- **The job never runs as root.** It runs as its own `memory-archive` user,
  with the filesystem read-only except `/var/lib/memory-archive`.

Not guaranteed: the archive is as fresh as the last successful run (at most 15
minutes behind when healthy), and it holds the git repository only, not any
other Cloudflare state.

Exit status: 0 the archive is current, 1 the run failed, 2 the program was
started without the settings it needs.

## Settings

The program reads these environment variables (`memory-archive --help` lists
them too). The systemd unit supplies them as shown in the next column.

| Variable | Meaning | Supplied by |
|---|---|---|
| `MEMORY_ARCHIVE_REMOTE` | Required. The repo's https URL, no credentials in it. | `/etc/memory-archive/config` |
| `MEMORY_ARCHIVE_TOKEN` | The repo token. Optional: when it is not set, the job reads `$CREDENTIALS_DIRECTORY/memory-archive-token`. Use it to run the job by hand; the unit does not set it, so the token stays out of the job's environment. | not set by the unit |
| `CREDENTIALS_DIRECTORY` | Set by systemd for `LoadCredential=`. | systemd |
| `MEMORY_ARCHIVE_ROOT` | Directory for the clone and the state. Default `/var/lib/memory-archive`. | the unit |
| `MEMORY_ARCHIVE_METRICS` | Path of a textfile metric file. No metrics are written when it is unset. | optional drop-in |
| `MEMORY_ARCHIVE_GIT` | The git program. Default `git`. | not set |
| `MEMORY_ARCHIVE_DEADLINE_SECONDS` | Time budget for the whole run. Default 240. | not set |

| Piece | Where |
|---|---|
| Program | `/usr/local/bin/memory-archive` |
| Units | `/etc/systemd/system/memory-archive.service` and `memory-archive.timer` |
| User | `memory-archive` (system user, no login) |
| Remote setting | `/etc/memory-archive/config` (one line, not secret) |
| Token | `/etc/memory-archive/token` (root-only, mode 0600) |
| Clone | `/var/lib/memory-archive/<repo name>/`, directory mode 0700 |
| State | `/var/lib/memory-archive/.state/state.json` |

## Create a read-only repo token

Create a read-only repo token for the notes repo (see Cloudflare's Artifacts
documentation). With Wrangler it looks like this, with the repo name and
namespace you gave memory-mcp:

```bash
npx wrangler artifacts repos issue-token "$REPO" --namespace "$NAMESPACE" --scope read --ttl 31536000 --json
```

The answer is JSON; the token is its `plaintext` field, including the
`?expires=` part, and `31536000` seconds is one year. The install steps below
pipe it straight into a root-only file so it is never shown or stored anywhere
else. The repo's URL is the `remote` field of
`npx wrangler artifacts repos get "$REPO" --namespace "$NAMESPACE" --json`.

## Install

You need a Linux machine with systemd, `git` and Python 3, and, to run the
steps below, `sudo`, `jq`, and Node.js with a Wrangler login that can read your
Artifacts namespace. If you would rather keep the Wrangler login on another
machine, run the two Wrangler commands there with their output going to files,
and copy the files to the archive machine as `/etc/memory-archive/config` and
`/etc/memory-archive/token` (mode 0600 for the token).

Run these from a checkout of this repository, on the archive machine.

Step 1: create the user and the settings directory.

```bash
id memory-archive >/dev/null 2>&1 || sudo useradd --system --no-create-home --home-dir /var/lib/memory-archive --shell /usr/sbin/nologin memory-archive
sudo install -d -m 0755 /etc/memory-archive
```

Step 2: store the repo's URL and a one-year read token. Set the first two
variables to your repo name and namespace.

```bash
REPO=memory
NAMESPACE=memory
npx wrangler artifacts repos get "$REPO" --namespace "$NAMESPACE" --json | jq -r '"MEMORY_ARCHIVE_REMOTE=" + .remote' | sudo tee /etc/memory-archive/config >/dev/null
sudo install -m 0600 /dev/null /etc/memory-archive/token
npx wrangler artifacts repos issue-token "$REPO" --namespace "$NAMESPACE" --scope read --ttl 31536000 --json | jq -r .plaintext | sudo tee /etc/memory-archive/token >/dev/null
sudo wc -c /etc/memory-archive/config /etc/memory-archive/token
```

Both files should report more than zero bytes. If the token file is empty the
first run says `failed step=token ... the token is empty or malformed`; run
the last two token commands again.

Step 3: install the program and the units, start the timer, and run the job
once now.

```bash
sudo install -m 0755 archive/memory-archive /usr/local/bin/memory-archive
sudo install -m 0644 archive/memory-archive.service /etc/systemd/system/memory-archive.service
sudo install -m 0644 archive/memory-archive.timer /etc/systemd/system/memory-archive.timer
sudo systemctl daemon-reload
sudo systemctl enable --now memory-archive.timer
sudo systemctl start memory-archive.service
sudo journalctl -u memory-archive.service -n 5 --no-pager
```

The last line of the output should read
`memory-archive: ok repo=<name> head=<12 hex> changed=yes`. The timer then runs
the job at :00, :15, :30 and :45 of every hour, and `Persistent=true` makes up
a run missed while the machine was off.

## Check that it works

Everything below is read-only.

```bash
sudo journalctl -u memory-archive.service -n 20 --no-pager
sudo systemctl list-timers memory-archive.timer --no-pager
sudo -u memory-archive git -C /var/lib/memory-archive/memory log --format='%h %an %ad %s' --date=iso -5
```

Change `memory` in the last command to your repo name. A healthy journal line
is `memory-archive: ok ...`, the timer shows the next quarter hour, and `git
log` shows your newest notes with the client that wrote each one.

**That the token is not on disk.** Optional, after at least one successful
run. This reads the token into a root shell variable and searches for it
without it appearing on any command line. It prints three numbers, which
should all be `0`: files under the paths searched that hold the token, journal
lines containing `Bearer`, and credential settings in the clone's git
configuration. The root-only file `/etc/memory-archive/token` is left out of
the search on purpose, because it is where the token is meant to be.

```bash
sudo bash -s <<'CHECK'
T=$(cut -d'?' -f1 /etc/memory-archive/token)
if [ "${#T}" -lt 20 ]; then echo could-not-read-token; exit 1; fi
for d in /var/lib/memory-archive /etc/systemd /tmp /var/tmp /root /home /usr/local /run/credentials; do [ -e "$d" ] && printf '%s\n' "$T" | grep -rlFf /dev/stdin "$d" 2>/dev/null; done | wc -l
journalctl -u memory-archive.service --no-pager | grep -c Bearer
sudo -u memory-archive git -C /var/lib/memory-archive/memory config --list --show-origin | grep -c -i -E 'helper|extraheader|@'
CHECK
```

If it prints `could-not-read-token` the check itself did not run; that is not
a pass. Change `memory` in the last command to your repo name.

## Metrics (optional)

To write a textfile metric file for a monitoring agent, add a drop-in that
sets the path and lets the sandboxed job write that one file. Set `METRICS` to
the file your monitoring agent reads.

```bash
METRICS=/var/lib/node_exporter/textfile_collector/memory_archive.prom
sudo install -m 0644 -o memory-archive -g memory-archive /dev/null "$METRICS"
sudo install -d /etc/systemd/system/memory-archive.service.d
printf '[Service]\nEnvironment=MEMORY_ARCHIVE_METRICS=%s\nReadWritePaths=%s\n' "$METRICS" "$METRICS" | sudo tee /etc/systemd/system/memory-archive.service.d/metrics.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl start memory-archive.service
cat "$METRICS"
```

All metrics carry the label `repo="<repo name>"`.

| Metric | Meaning |
|---|---|
| `memory_archive_last_run_timestamp_seconds` | When the job last ran |
| `memory_archive_last_run_ok` | 1 if that run succeeded, else 0 |
| `memory_archive_last_success_timestamp_seconds` | When the archive was last confirmed current; kept across failed runs; 0 if never |
| `memory_archive_token_expiry_timestamp_seconds` | The token's expiry, read from its `?expires=` part; kept from the last run that could read the token |
| `memory_archive_head_commit_timestamp_seconds` | Commit time of the archived `main` |

The file is rewritten in place (one write, then cut to length), never emptied
first, so a monitoring agent never reads an empty file. The state the job
depends on is not kept in it.

## Alerting from the metrics (optional)

Three conditions are worth a notice. They are written as PromQL-style
expressions; adapt them to your monitoring system.

| Condition | Expression | Why |
|---|---|---|
| Copy is stale | `time() - memory_archive_last_success_timestamp_seconds > 14400`, for 1 hour | No successful update for about five hours. Treat a missing series as firing too: a machine that stopped reporting is also a stale copy. |
| Token expires in 30 days | `(memory_archive_token_expiry_timestamp_seconds - time()) / 86400 < 30` | Time to issue a new token without hurry. |
| Token expires in 7 days | `(memory_archive_token_expiry_timestamp_seconds - time()) / 86400 < 7` | The first notice was missed or ignored. |

Alert only when someone has something to do. The stale condition clears by
itself on the next successful run, and the token conditions clear when a new
token is stored, because the expiry metric jumps a year ahead. A plain
threshold repeats for as long as it is true; if you want each token notice
sent once, make it a window instead (for example days left between 29 and 30)
so it is true only for a day. `memory_archive_last_run_ok == 0` is a faster
signal that a run failed, but a single failure is often a passing network
problem, so the stale condition is the one to wake someone for.

## Restore from the copy

The clone is an ordinary git repository with every commit, and the notes are
plain Markdown files in its working tree. To read them, copy the clone out of
the job's private directory and look at it. Set `REPO` to your repo name and
`DEST` to where the copy should go.

```bash
REPO=memory
DEST="$HOME/notes-restore"
sudo cp -a "/var/lib/memory-archive/$REPO" "$DEST"
sudo chown -R "$(id -un)" "$DEST"
git -C "$DEST" log --oneline -5
ls "$DEST"
```

To move the notes to a new git host, point the copy at it and push `main`.
Set `NEW_REMOTE` to the empty repository's URL; the push needs a credential
that can write to it, which is the new host's business, not this job's.

```bash
NEW_REMOTE=https://git.example.com/you/notes.git
git -C "$DEST" remote set-url origin "$NEW_REMOTE"
git -C "$DEST" push origin main
```

**If a run says `step=diverged`.** The hosted repo's `main` no longer contains
the archived one. That happens if its history was rewritten or the repo was
replaced, on purpose or not. The job changed nothing, and keeps failing until
you decide. Inspect both sides first. If the new history is the one you want to
follow, move the old clone aside so it is kept, and the next run clones
afresh:

```bash
sudo mv "/var/lib/memory-archive/$REPO" "/var/lib/memory-archive/$REPO.old-$(date +%Y%m%d)"
sudo systemctl start memory-archive.service
```

A different repo in `MEMORY_ARCHIVE_REMOTE` never reuses an old clone: the
clone's directory is named for the repo, so pointing the job at another repo
makes a new directory beside the old one.

## Rotate the token

The token lasts as long as the `--ttl` you gave it (one year above). Replace it
before it expires, or sooner if it may have leaked. The job reads the file on
every run, so there is nothing to restart. Set `REPO` and `NAMESPACE` first.

```bash
REPO=memory
NAMESPACE=memory
npx wrangler artifacts repos issue-token "$REPO" --namespace "$NAMESPACE" --scope read --ttl 31536000 --json | jq -r .plaintext | sudo tee /etc/memory-archive/token >/dev/null
sudo systemctl start memory-archive.service
sudo journalctl -u memory-archive.service -n 3 --no-pager
```

The same command issues a new token without invalidating the old one, which
stays valid until it expires. To cut it off sooner, revoke it through
Cloudflare's Artifacts API or dashboard (the token's `id` is in the same JSON
answer).

## Steps a failure can name

`remote` (the URL is refused, or the clone's origin is not the configured
remote), `token` (missing, empty, or no expiry), `clone`, `fetch` (the
network, or 401/403 for an expired or revoked token), `refs`, `diverged`,
`checkout`, `merge`, `deadline` (the watchdog), `state`, `metrics`.

## Tests

From the repository root:

```bash
uv run --with pytest pytest archive
```

## Removing it

```bash
sudo systemctl disable --now memory-archive.timer
sudo rm -f /etc/systemd/system/memory-archive.service /etc/systemd/system/memory-archive.timer /usr/local/bin/memory-archive
sudo rm -rf /etc/memory-archive /etc/systemd/system/memory-archive.service.d
sudo systemctl daemon-reload
```

`/var/lib/memory-archive` is left on purpose: it is the archive. Revoke the
repo token as well.
