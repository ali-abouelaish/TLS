#!/usr/bin/env bash
# Installs or updates the Trusted Let website on an Ubuntu/Debian VPS. Run it from the uploaded folder:
#   sudo bash ~/trustedlet/deploy/install.sh
#
# Needs Node 20.12+ and, for https, Caddy (https://caddyserver.com/docs/install). Safe to re-run for
# every update. It:
#   - copies the site to /srv/trustedlet, keeping the .env already there (it holds the Harbor secret)
#   - fills in SESSION_SECRET if it is empty
#   - refreshes the listings once, and daily at 06:00 via /etc/cron.d/trustedlet
#   - runs server.mjs as the trustedlet systemd service, as www-data on 127.0.0.1
#   - adds the site to Caddy for HARBOR_SIGN_IN_AUDIENCE's host, if it isn't in the Caddyfile yet
set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DEST=/srv/trustedlet
ENV_FILE=$DEST/.env
CADDYFILE=/etc/caddy/Caddyfile
MARK='# trustedlet: added by deploy/install.sh'

say() { printf '\n== %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
env_get() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '\r' || true; }

[ "$(id -u)" -eq 0 ] || die "run with sudo: sudo bash $0"
NODE=$(command -v node) || die "Node.js is not installed (needs 20.12 or newer)"
"$NODE" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 20 || (a === 20 && b >= 12) ? 0 : 1)' \
  || die "Node $("$NODE" --version) is too old: install 20.12 or newer"

say "Copying the site to $DEST"
mkdir -p "$DEST"
if [ "$SRC" != "$DEST" ]; then
  tar -C "$SRC" --exclude=./.env --exclude=./deploy -cf - . | tar -C "$DEST" --no-same-owner -xf -
  if [ ! -f "$ENV_FILE" ]; then
    if [ -f "$SRC/.env" ]; then cp "$SRC/.env" "$ENV_FILE"; else cp "$SRC/.env.example" "$ENV_FILE"; fi
    echo "Created $ENV_FILE"
  else
    echo "Kept the existing $ENV_FILE"
  fi
fi
sed -i 's/\r$//' "$ENV_FILE"

if [ -z "$(env_get SESSION_SECRET)" ]; then
  secret=$("$NODE" -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
  if grep -q '^SESSION_SECRET=' "$ENV_FILE"; then sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$secret|" "$ENV_FILE"
  else printf '\nSESSION_SECRET=%s\n' "$secret" >> "$ENV_FILE"; fi
  echo "Generated SESSION_SECRET"
fi

AUDIENCE=$(env_get HARBOR_SIGN_IN_AUDIENCE)
PORT=$(env_get PORT); PORT=${PORT:-3000}
[[ "$AUDIENCE" =~ ^https://[a-z0-9.-]+$ ]] \
  || die "set HARBOR_SIGN_IN_AUDIENCE in $ENV_FILE to the site's address, e.g. https://www.trustedlet.co.uk, then re-run"
DOMAIN=${AUDIENCE#https://}

chown -R www-data:www-data "$DEST"
chmod 600 "$ENV_FILE"
chmod 750 "$DEST/private"

say "Refreshing the listings from Harbor Ops"
sudo -u www-data bash -c "cd '$DEST' && '$NODE' scripts/fetch-listings.mjs" \
  || warn "could not refresh the listings; the uploaded snapshot is used until the daily run works (check HARBOR_OPS_API_KEY in $ENV_FILE)"

cat > /etc/cron.d/trustedlet <<EOF
# Daily Harbor Ops listings snapshot for the Trusted Let website (deploy/install.sh)
0 6 * * * www-data cd $DEST && $NODE scripts/fetch-listings.mjs 2>&1 | logger -t trustedlet-listings
EOF
chmod 644 /etc/cron.d/trustedlet

say "Starting the trustedlet service"
sed "s|/usr/bin/node|$NODE|" "$SRC/deploy/trustedlet.service" > /etc/systemd/system/trustedlet.service
systemctl daemon-reload
systemctl enable trustedlet >/dev/null
systemctl restart trustedlet
for _ in $(seq 1 20); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/listings.json" 2>/dev/null && break; sleep 0.5; done
curl -fsS -o /dev/null "http://127.0.0.1:$PORT/listings.json" || die "the site isn't answering: see journalctl -u trustedlet -n 50"
journalctl -u trustedlet -n 3 --no-pager -o cat || true

say "Caddy (https for $DOMAIN)"
if ! command -v caddy >/dev/null; then
  warn "Caddy is not installed: install it (https://caddyserver.com/docs/install) and re-run this script"
elif grep -qF "$MARK" "$CADDYFILE" 2>/dev/null; then
  echo "Already in $CADDYFILE; edit it there if the domain changed"
else
  [ -f "$CADDYFILE" ] && cp "$CADDYFILE" "$CADDYFILE.bak.$(date +%Y%m%d%H%M%S)"
  block="$MARK
$DOMAIN {
	reverse_proxy 127.0.0.1:$PORT
}"
  if [[ "$DOMAIN" == www.* ]]; then
    block="$block
${DOMAIN#www.} {
	redir https://$DOMAIN{uri}
}"
  fi
  # Replace the package's placeholder site; otherwise add to what is there.
  if [ ! -f "$CADDYFILE" ] || grep -q 'root \* /usr/share/caddy' "$CADDYFILE"; then
    printf '%s\n' "$block" > "$CADDYFILE"
  else
    printf '\n%s\n' "$block" >> "$CADDYFILE"
  fi
  caddy validate --adapter caddyfile --config "$CADDYFILE" >/dev/null || die "Caddy rejected $CADDYFILE (a backup is next to it)"
  systemctl reload caddy
  echo "Added $DOMAIN to $CADDYFILE"
fi

say "Done"
echo "Public site:  https://$DOMAIN  (needs DNS for $DOMAIN pointing at this server)"
echo "Sign-in URL:  $AUDIENCE/harbor-sign-in  (enter it in Harbor Ops)"
if [ -z "$(env_get HARBOR_SIGN_IN_SECRET)" ]; then
  echo "Staff sign-in is OFF until you paste the Harbor Ops secret into $ENV_FILE:"
  echo "  sudo nano $ENV_FILE        (HARBOR_SIGN_IN_SECRET=hos_...)"
  echo "  sudo systemctl restart trustedlet"
fi
echo "Logs: journalctl -u trustedlet -f"
