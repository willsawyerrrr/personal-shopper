# Deployment

Runs on an always-on Windows PC via WSL, exposed publicly through a
Cloudflare Tunnel. The bearer secret on `/items` is the only auth boundary
once the tunnel makes the service reachable from the internet, so treat
`SHARED_SECRET` accordingly.

## WSL setup

```powershell
wsl --install -d Ubuntu  # if not already installed
```

Inside the WSL distro, enable systemd (edit `/etc/wsl.conf`):

```ini
[boot]
systemd=true
```

Then restart the distro (`wsl --shutdown` from Windows, reopen).

## Install Node + pnpm

```bash
curl -fsSL https://fnm.vercel.app/install | bash  # or your preferred Node installer
fnm install 24
corepack enable
corepack prepare pnpm@11.22.0 --activate
```

## Install and run the service

```bash
git clone https://github.com/willsawyerrrr/personal-shopper.git
cd personal-shopper
pnpm install --frozen-lockfile
cp .env.example .env        # fill in SHARED_SECRET
cp items.example.yml items.yml  # fill in real stockcodes
pnpm capture-session         # one-time (and periodic) manual login
pnpm build
```

Systemd user service (`~/.config/systemd/user/personal-shopper.service`):

```ini
[Unit]
Description=Personal Shopper webhook

[Service]
WorkingDirectory=/home/<user>/personal-shopper
ExecStart=/home/<user>/.local/share/pnpm/pnpm start
EnvironmentFile=/home/<user>/personal-shopper/.env
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now personal-shopper
loginctl enable-linger $USER   # keep the user service running without a login session
```

## Cloudflare Tunnel

```bash
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
cloudflared tunnel login
cloudflared tunnel create personal-shopper
cloudflared tunnel route dns personal-shopper shopper.willsawyerrrr.dev
```

Config (`~/.cloudflared/config.yml`):

```yaml
tunnel: personal-shopper
credentials-file: /home/<user>/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: shopper.willsawyerrrr.dev
    service: http://localhost:3000
  - service: http_status:404
```

Run it as a systemd user service the same way as above
(`ExecStart=cloudflared tunnel run personal-shopper`), or `sudo cloudflared
service install` for a system-level unit if you'd rather it survive user
logout without lingering.
