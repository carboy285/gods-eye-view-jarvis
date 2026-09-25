#!/usr/bin/env bash
# Creates a private certificate authority (once) and an HTTPS certificate for
# this machine, so phones and laptops on the home network can use the mic.
#
#   bash scripts/make-local-cert.sh 192.168.1.10 [more LAN IPs or names]
#
# Files go to ~/.gods-eye-view/certs (override with GEV_CERT_DIR). The CA is
# reused on later runs so devices only trust it once; re-run to renew the
# server certificate before it expires (397 days, Apple's limit).
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash would otherwise rewrite "/CN=..." as a path.

if [ "$#" -eq 0 ]; then
  echo "Usage: bash scripts/make-local-cert.sh <LAN IP> [more IPs or hostnames]" >&2
  exit 2
fi

dir="${GEV_CERT_DIR:-$HOME/.gods-eye-view/certs}"
mkdir -p "$dir"
cd "$dir"
host="$(hostname | tr '[:upper:]' '[:lower:]')"

# The CA may only vouch for private addresses and local names, so even a
# leaked CA key cannot impersonate real websites to devices that trust it.
constraints="critical,permitted;IP:10.0.0.0/255.0.0.0,permitted;IP:172.16.0.0/255.240.0.0"
constraints+=",permitted;IP:192.168.0.0/255.255.0.0,permitted;IP:127.0.0.0/255.0.0.0"
constraints+=",permitted;IP:100.64.0.0/255.192.0.0"
constraints+=",permitted;DNS:localhost,permitted;DNS:.local,permitted;DNS:$host"

if [ ! -f ca.key ] || [ ! -f ca.crt ]; then
  openssl req -x509 -new -nodes -newkey rsa:2048 -sha256 -days 3650 \
    -keyout ca.key -out ca.crt \
    -subj "/CN=God's Eye View Local CA ($host)/O=God's Eye View" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "nameConstraints=$constraints" \
    -addext "subjectKeyIdentifier=hash" 2>/dev/null
  echo "Created a new local CA: $dir/ca.crt"
else
  echo "Reusing the existing local CA: $dir/ca.crt"
fi

san="DNS:localhost,DNS:$host,DNS:$host.local,IP:127.0.0.1"
for name in "$@"; do
  if [[ "$name" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then san+=",IP:$name"; else san+=",DNS:$name"; fi
done

cat > server.ext <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$san
authorityKeyIdentifier=keyid,issuer
subjectKeyIdentifier=hash
EOF

openssl req -new -nodes -newkey rsa:2048 -sha256 \
  -keyout server.key -out server.csr -subj "/CN=God's Eye View ($host)" 2>/dev/null
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days 397 -sha256 -extfile server.ext 2>/dev/null
rm -f server.csr server.ext
openssl verify -CAfile ca.crt server.crt >/dev/null

echo "Issued server certificate for: $san"
echo
echo "Add to .env, then restart:"
echo "  GEV_HTTPS_CERT=$(cd "$dir" && pwd -W 2>/dev/null || pwd)/server.crt"
echo "  GEV_HTTPS_KEY=$(cd "$dir" && pwd -W 2>/dev/null || pwd)/server.key"
