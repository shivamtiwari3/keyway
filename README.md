# Keyway

**Use any model provider inside Claude Desktop — bring your own key.**

Keyway is a tiny local gateway (loopback only) that lets Claude Desktop talk to
whatever model provider you already pay for — OpenAI, Anthropic, OpenRouter,
Groq, DeepSeek, a local Ollama, or any OpenAI- or Anthropic-compatible endpoint.
No subscription required from us; you supply the endpoint and key.

```
Claude Desktop ──▶ 127.0.0.1:8788 (Keyway) ──▶ your provider
```

## Features

- **Bring your own key** — any OpenAI- or Anthropic-compatible endpoint.
- **Auto-detection** — the gateway probes your endpoint and picks the right
  protocol (Anthropic pass-through, or OpenAI ↔ Anthropic translation). You
  never choose a "mode".
- **Streaming + tool calls** supported in both modes.
- **Menu bar status** — `✓ Connected` / `⚠ Off`, with provider + model count.
- **One-click setup app** — paste endpoint + key + models; it writes the Claude
  Desktop profile and starts the gateway at login.
- **Loopback only** — the gateway binds `127.0.0.1`; your key never leaves your
  machine except to the provider you chose.

## Requirements

- macOS 13 or later
- Claude Desktop installed
- A model provider endpoint + API key

Users do **not** need Node, Xcode, or a terminal: the release app bundles
everything.

## Install (users)

1. Download `Keyway-Setup.zip` from Releases and unzip it.
2. Right-click **Keyway.app → Open** (once, to pass Gatekeeper).
3. Enter your provider (e.g. OpenAI), API key, and model(s) → **Install**.
4. Claude Desktop restarts using your models. The menu bar shows `✓ Connected`.
5. To remove: open Keyway again → **Remove**.

The app writes:

```
~/Library/Application Support/Keyway/            gateway + config + key (chmod 600)
~/Library/LaunchAgents/dev.keyway.gateway.plist  login service
~/Library/Application Support/Claude-3p/          Claude Desktop gateway profile
```

## Build from source

Requires macOS with `swiftc` (Xcode Command Line Tools) and Node.

```sh
make build      # produces dist/Keyway.app and dist/Keyway-Setup.zip
make install    # install using env: PROVIDER/UPSTREAM/API_KEY_FILE/MODELS
make uninstall
```

Or run pieces directly:

```sh
node gateway.mjs                 # reads ./config.json
node setup.mjs install --key KEY --provider-name OpenAI \
  --upstream https://api.openai.com/v1 --api auto --models gpt-4o-mini
node setup.mjs uninstall
node setup.mjs status
```

## How it works

- `gateway.mjs` — a ~250-line dependency-free HTTP server on `127.0.0.1:8788`
  that speaks the Anthropic Messages API to Claude Desktop and forwards to your
  provider. If the provider is Anthropic-compatible it passes through; otherwise
  it translates to/from OpenAI Chat Completions (streaming and tools included).
- `setup.mjs` — installs/uninstalls: bundles the gateway, writes the Claude
  Desktop "3p" gateway profile, registers a launchd login service.
- `app/main.swift` — the SwiftUI setup window + menu bar status item.

Claude Desktop only accepts gateway model routes that reference an Anthropic
model name, so Keyway advertises routes like `claude-sonnet-4-5` and maps each
one to the real provider model in the gateway (see `modelMap` in `config.json`).

## Security / privacy

- Binds loopback only (`127.0.0.1`).
- Your API key is stored at `~/Library/Application Support/Keyway/key`
  (`chmod 600`) and sent only to the provider endpoint you configured.
- No telemetry.
- `Copy Diagnostics` in the menu bar copies status + log path (never the key).

## Troubleshooting

- **Menu bar shows `Off`** — the gateway isn't running. Check
  `~/Library/Application Support/Keyway/gateway.log`, then re-open Keyway and
  reinstall.
- **401 from the provider** — wrong/missing key.
- **"Gateway couldn't start"** — port 8788 is in use; change `port` in
  `config.json` and the profile's URL.
- **Gatekeeper blocks the app** — right-click → Open, or sign/notarize with your
  own Developer ID.

## License

MIT — see [LICENSE](LICENSE).
