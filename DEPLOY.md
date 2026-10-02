# Deploying SOLEYE on Oracle Cloud Always Free (Ubuntu, ARM)

Runs 24/7 under pm2 on an Always Free Ampere A1 VM. No paid services involved.

> **Read before you start (checked against Oracle docs, Oct 2026)**
> - **Sign-up asks for a credit/debit card** for identity verification. Always Free resources are not charged, but the card is required to create the account. If that is a deal-breaker, the same steps work on any always-on Ubuntu/Debian box (an old laptop, a Raspberry Pi 4/5) — skip to step 3.
> - **Always Free A1 = 2 OCPU + 12 GB RAM total** (1,500 OCPU-hours / 9,000 GB-hours per month).
> - **Idle reclamation:** Oracle may reclaim an Always Free instance if, over 7 days, 95th-percentile CPU, network **and** memory (A1) are all below 20%. This bot is light, so it can look idle. Options: (a) upgrade the account to *Pay As You Go* — Always Free resources stay $0 and PAYG accounts are not subject to idle reclamation; (b) **stay 100% free and avoid it**: give the VM the *smallest memory the console allows* (1 GB if offered, else 2 GB). All three metrics must be under 20% to count as idle, and the bot + Ubuntu use well over 20% of 1–2 GB, so the VM is never idle. Verify after a day with `free -m` (the "used" column should be over 20% of "total"); (c) keep backups of `data/` (see below) so a reclaim costs minutes, not history.

---

## 1. Create the VM

1. Sign up at <https://www.oracle.com/cloud/free/> and pick a **home region** with A1 capacity (you cannot change it later).
2. Console → **Compute → Instances → Create instance**.
   - **Image:** Canonical Ubuntu 24.04 (aarch64).
   - **Shape:** *Change shape* → **Ampere** → `VM.Standard.A1.Flex` → **1 OCPU** and the **smallest memory offered (1 GB, or 2 GB)**. The bot needs ~150 MB; keeping total memory small keeps usage above Oracle's 20% idle threshold (see the reclamation note). Add the swap file in step 3 so `npm ci` has room.
   - **Networking:** default VCN with a public subnet, *Assign a public IPv4 address* = yes.
   - **SSH keys:** *Generate a key pair* and download the private key (or paste your own public key).
3. Click **Create**. If you get *Out of capacity*, retry later or pick another availability domain.
4. Copy the **Public IP** from the instance page.

No inbound ports need opening: the bot only makes outbound HTTPS calls (Telegram long polling, APIs).

## 2. SSH in

```bash
chmod 600 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<PUBLIC_IP>
```

## 3. Install Node.js, build tools and git

Node 20 is supported, but it reached end-of-life in April 2026; Node 22 LTS is recommended.

```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get install -y git build-essential python3 ca-certificates curl fonts-dejavu-core
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v && npm -v
```

(`fonts-dejavu-core` provides the font used for text on alert chart images. `build-essential`/`python3` are only needed if `better-sqlite3` has no prebuilt binary for your platform; linux-arm64 usually has one.)

Optional but recommended on a 1–2 GB VM — add swap so `npm install` never runs out of memory:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Set the clock zone to UTC (alerts/logs use UTC):

```bash
sudo timedatectl set-timezone UTC
```

## 4. Clone and build

```bash
cd ~
git clone <YOUR_REPO_URL> soleye
cd soleye
npm ci
npm test          # detector + filter tests must pass
npm run build     # compiles to dist/
```

No git remote? Copy the folder instead (from your PC, excluding `node_modules`):
`scp -i <key> -r soleye ubuntu@<PUBLIC_IP>:~/` then run `npm ci && npm run build` on the VM.

## 5. Configure `.env`

1. In Telegram, talk to **@BotFather** → `/newbot` → copy the token.
2. On the VM:

```bash
cp .env.example .env
nano .env        # set TELEGRAM_BOT_TOKEN=123456:ABC...
chmod 600 .env
```

`RPC_URL` is optional (defaults to the public mainnet RPC).

Quick sanity run (Ctrl+C after you see `telegram bot connected` and `watchlist refreshed`):

```bash
node dist/index.js
```

## 6. Run with pm2

```bash
sudo npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 status
pm2 logs soleye --lines 50
```

Log rotation so logs never fill the disk:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

## 7. Start on reboot

```bash
pm2 startup systemd -u ubuntu --hp /home/ubuntu
# pm2 prints a `sudo env PATH=... pm2 startup ...` command — copy and run it exactly.
pm2 save
```

Verify: `sudo reboot`, reconnect after a minute, then `pm2 status` should show `soleye` **online**.

## 8. Use it

Open your bot in Telegram and send `/start`. Other commands: `/status`, `/settings`, `/recent`, `/stats`, `/stop`.
The first discovery runs immediately, the first pattern scan ~90 s later.

---

## Operations

| Task | Command |
|---|---|
| Logs | `pm2 logs soleye` |
| Restart | `pm2 restart soleye` |
| Stop | `pm2 stop soleye` |
| Update code | `git pull && npm ci && npm run build && pm2 restart soleye` |
| Change thresholds | edit `src/config.ts`, then `npm run build && pm2 restart soleye` |
| Backup DB | `sqlite3 data/soleye.db ".backup data/backup-$(date +%F).db"` (install with `sudo apt-get install -y sqlite3`) |

Daily backup via cron (`crontab -e`):

```
0 4 * * * cd /home/ubuntu/soleye && sqlite3 data/soleye.db ".backup data/backup-$(date +\%u).db"
```

### Seeing 429s in logs?
The bot backs off and slows itself down automatically. If GeckoTerminal 429s are still frequent, lower `GT_RPM` in `.env` (e.g. `GT_RPM=4`). If you see none for a day, try `GT_RPM=6`–`8` to scan more tokens per cycle (check `/status` for the scan summary).
