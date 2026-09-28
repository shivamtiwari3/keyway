# Security Policy

## Reporting a vulnerability

Please open a private security advisory via GitHub:
**Security → Advisories → Report a vulnerability**
(https://github.com/shivamtiwari3/keyway/security/advisories/new)

Or email the maintainer. We aim to acknowledge within 72 hours.

## Scope

Keyway is a local proxy that handles your model-provider API key. In-scope:

- The gateway (`gateway.mjs`) and installer (`setup.mjs`)
- The macOS app (`app/main.swift`) and build (`make-dist.sh`)

## Design / threat model

- The gateway binds **loopback only** (`127.0.0.1`) — it is not reachable from
  the network.
- The API key is stored at `~/Library/Application Support/Keyway/key` with mode
  `600`, and is sent **only** to the endpoint you configure.
- The key is **never** logged. `Copy Diagnostics` copies status + log path only.
- No telemetry, no phoning home.

If you find a way to (a) read the key without local access, (b) reach the gateway
from off-host, or (c) leak the key to a third party, please report it.
