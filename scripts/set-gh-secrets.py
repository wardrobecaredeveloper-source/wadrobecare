#!/usr/bin/env python3
"""Encrypt and set GitHub Actions secrets for the wadrobecare repo."""
import base64
import json
import os
import sys
import urllib.request
from nacl import encoding, public

GH_TOKEN = os.environ['GH_TOKEN']
REPO = 'wardrobecaredeveloper-source/wadrobecare'

# Step 1: fetch repo public key
print("=== Fetching repo public key ===")
req = urllib.request.Request(
    f"https://api.github.com/repos/{REPO}/actions/secrets/public-key",
    headers={"Authorization": f"token {GH_TOKEN}", "Accept": "application/vnd.github.v3+json"},
)
with urllib.request.urlopen(req) as resp:
    pk_data = json.load(resp)
print(f"  key_id: {pk_data['key_id']}")

pub_key = public.PublicKey(pk_data['key'].encode(), encoding.Base64Encoder())
sealed_box = public.SealedBox(pub_key)

# Step 2: encrypt and PUT each secret
secrets_to_set = {
    "CLOUDFLARE_API_TOKEN": os.environ['CF_TOKEN'],
    "CLOUDFLARE_ACCOUNT_ID": os.environ['CF_ACCOUNT'],
    "HYPERDRIVE_ID": os.environ['HYPERDRIVE_ID'],
    "DATABASE_URL": os.environ['NEON_URL'],
}

for name, value in secrets_to_set.items():
    print(f"\n=== Setting secret: {name} ===")
    encrypted = sealed_box.encrypt(value.encode())
    body = {
        "encrypted_value": base64.b64encode(encrypted).decode(),
        "key_id": pk_data['key_id'],
    }
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}/actions/secrets/{name}",
        data=json.dumps(body).encode(),
        method="PUT",
        headers={
            "Authorization": f"token {GH_TOKEN}",
            "Accept": "application/vnd.github.v3+json",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req) as resp:
            print(f"  status: {resp.status}")
            print(f"  set: {name}")
    except urllib.error.HTTPError as e:
        print(f"  ERROR: {e.code} {e.reason}")
        print(f"  body: {e.read().decode()[:200]}")
        sys.exit(1)

# Step 3: list secrets to verify
print("\n=== Verifying secrets are set ===")
req = urllib.request.Request(
    f"https://api.github.com/repos/{REPO}/actions/secrets",
    headers={"Authorization": f"token {GH_TOKEN}", "Accept": "application/vnd.github.v3+json"},
)
with urllib.request.urlopen(req) as resp:
    d = json.load(resp)
    for s in d.get('secrets', []):
        print(f"  - {s['name']} (created: {s.get('created_at', '?')[:10]})")
print("\n=== All secrets set successfully ===")
