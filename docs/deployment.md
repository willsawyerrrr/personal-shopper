# Deployment

The service runs anywhere `pnpm dev`/`pnpm start` runs — same code, same
config, no separate "dev build". Use your own machine for local development
and testing (`pnpm dev`, then `POST /items` and `/admin` against
`localhost`); production is an always-on Windows PC, reachable only over
your home network — no public internet exposure, no tunnel, no DNS.

This is a deliberate choice, not a limitation worked around: Woolworths'
login requires a real, visible browser you can approve with a passkey or
SMS code, so `pnpm capture-session` needs to run somewhere you're physically
present anyway. Running natively on Windows (rather than inside WSL) means
that browser gets real Windows Hello / passkey support directly, and the
service is trivially reachable from your phone's Shortcuts automation over
LAN — no Cloudflare account, no subdomain delegation, no WSL2
port-forwarding workarounds.

`SHARED_SECRET` gates both the bearer-authed `/items` webhook and the
Basic-Auth-protected `/admin` UI (username is ignored, password is
`SHARED_SECRET`). Since nothing here leaves your home network, this is
belt-and-braces rather than the only thing standing between the service and
the internet — but treat it as a real secret regardless.

## Install Node + pnpm

In an elevated PowerShell prompt:

```powershell
winget install Schniz.fnm
fnm install 24
fnm use 24
corepack enable
corepack prepare pnpm@11.22.0 --activate
```

Verify with `node --version` (`v24.x.x`) and `pnpm --version` (`11.22.0`).

## Install and run the service

```powershell
git clone https://github.com/willsawyerrrr/personal-shopper.git
cd personal-shopper
pnpm install --frozen-lockfile
Copy-Item .env.example .env        # fill in SHARED_SECRET
pnpm capture-session                # opens a real Chrome window — log in
                                     # with your passkey and set your Direct
                                     # to boot store, then press Enter in
                                     # this terminal
pnpm build
```

Add items via `/admin` or the Chrome extension once the service is running
below, rather than hand-editing `items.yml`.

## Run at startup

A Scheduled Task with an "At startup" trigger survives reboots without
needing anyone logged in, and restarts the process if it crashes. Registering
a task that runs as `SYSTEM` requires an **elevated** PowerShell prompt (Run
as Administrator) — a non-elevated session fails with "Access is denied".

Find `node.exe`'s stable install path first. `(Get-Command node).Source`
looks right but resolves through `fnm`'s per-session "multishell" symlink,
which stops existing once that specific shell session closes — a task built
on that path runs fine until you close the window you registered it from,
then fails silently (`LastTaskResult` nonzero, nothing listening on the
port). Search for the real, persistent install instead:

```powershell
$nodePath = Get-ChildItem -Path $env:LOCALAPPDATA,$env:APPDATA -Recurse -Filter node.exe -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch 'multishell' } |
  Select-Object -First 1 -ExpandProperty FullName
```

Then register the task, pointing at the compiled entrypoint
(`dist/src/server.js` — `tsc`'s output mirrors `src/`'s structure, it is not
flattened into `dist/` directly):

```powershell
$action = New-ScheduledTaskAction `
  -Execute $nodePath `
  -Argument '--env-file=.env dist/src/server.js' `
  -WorkingDirectory (Get-Location)
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'PersonalShopper' -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -User 'SYSTEM'
Start-ScheduledTask -TaskName 'PersonalShopper'
```

Verify it actually started — `Get-ScheduledTaskInfo -TaskName
'PersonalShopper'`'s `LastTaskResult` should read `0`. Task Scheduler
doesn't capture the process's stdout/stderr, so if something's still wrong,
run the same command directly in a terminal to see the real error:

```powershell
& $nodePath --env-file=.env dist/src/server.js
```

To pick up an update later: `git pull`, `pnpm install --frozen-lockfile`,
`pnpm build`, then `Restart-ScheduledTask -TaskName 'PersonalShopper'` (or
`Stop-ScheduledTask` + `Start-ScheduledTask`).

## Firewall

Allow the port on your home network only — the `Private` profile excludes
public/untrusted networks by default:

```powershell
New-NetFirewallRule -DisplayName 'Personal Shopper' -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private
```

## Reaching it from Shortcuts

Find the PC's LAN IP with `ipconfig` (the `IPv4 Address` under your active
adapter), then point the Shortcuts automation's "Get Contents of URL" at
`http://<that-ip>:3000/items`. Reserve a static DHCP lease for the PC in
your router's settings so this IP doesn't change and break the automation —
otherwise every router reboot is a live risk.
