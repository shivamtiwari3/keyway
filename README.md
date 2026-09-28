# Keyway

**Use any model inside Claude Desktop — bring your own key.**

Keyway is a tiny local gateway (loopback only) that lets Claude Desktop talk to
the model provider you already pay for. Point it at **any OpenAI- or
Anthropic-compatible endpoint**, and Claude Desktop uses it — no subscription from
us, no middleman, no telemetry.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/shivamtiwari3/keyway?label=release)](https://github.com/shivamtiwari3/keyway/releases)
![Platform](https://img.shields.io/badge/platform-macOS%2013%2B%20%7C%20Windows%2010%2F11-black)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

**🔗 Website:** https://shivamtiwari3.github.io/keyway/ &nbsp;·&nbsp;
**⬇︎ Download:** [Keyway-Setup.zip](https://github.com/shivamtiwari3/keyway/releases/latest/download/Keyway-Setup.zip) &nbsp;·&nbsp;
**🐞 Issues:** https://github.com/shivamtiwari3/keyway/issues

```
Claude Desktop ──▶  127.0.0.1:8788 (Keyway)  ──▶  your provider
```

---

## Features

- **Bring your own key** — any OpenAI- or Anthropic-compatible endpoint.
- **Auto-detects the protocol** — probes your endpoint and uses Anthropic
  pass-through or OpenAI ↔ Anthropic translation. You never pick a "mode".
- **Streaming + tool calls** — full SSE streaming and tool-use translation.
- **Menu bar status** — `✓ Connected` / `⚠ Off` with provider + model count.
- **One-click setup app** — paste endpoint + key + model; it writes Claude
  Desktop's profile and starts the gateway at login.
- **Private by design** — binds `127.0.0.1` only; your key is stored locally
  (`chmod 600`) and sent only to the provider you chose. No telemetry.
- **Small & auditable** — a ~300-line dependency-free gateway. MIT licensed.

## Supported providers

| Provider | Preset endpoint | Protocol |
|---|---|---|
| Anthropic | `https://api.anthropic.com` | Anthropic |
| OpenAI | `https://api.openai.com/v1` | OpenAI |
| OpenRouter | `https://openrouter.ai/api/v1` | OpenAI |
| Groq | `https://api.groq.com/openai/v1` | OpenAI |
| DeepSeek | `https://api.deepseek.com/anthropic` | Anthropic |
| Ollama (local) | `http://127.0.0.1:11434/v1` | OpenAI |
| **Anything else** | choose **Custom** | auto-detected |

## Requirements

- macOS 13 or later (Apple Silicon or Intel — the release app is universal), **or**
  Windows 10/11 (x64 or ARM64)
- Claude Desktop installed
- A model provider endpoint + API key

End users do **not** need Node, Xcode, or a terminal — the release app bundles
its own runtime.

---

## Install (users)

### macOS

1. Download **[Keyway-Setup.zip](https://github.com/shivamtiwari3/keyway/releases/latest/download/Keyway-Setup.zip)** and unzip it.
2. **Right-click `Keyway.app` → Open** (once — macOS Gatekeeper, since the build
   is unsigned).
3. Enter your **provider**, **API key**, and **model(s)** → **Install**.
4. Claude Desktop restarts using your models. The menu bar shows `✓ Connected`.

To remove: open Keyway again → **Remove**.

### What it writes

```
~/Library/Application Support/Keyway/            gateway + config.json + key (chmod 600)
~/Library/LaunchAgents/dev.keyway.gateway.plist  login service
~/Library/Application Support/Claude-3p/          Claude Desktop gateway profile
```

### Windows

1. Download **[Keyway-Windows-x64.zip](https://github.com/shivamtiwari3/keyway/releases/latest/download/Keyway-Windows-x64.zip)**
   (or [ARM64](https://github.com/shivamtiwari3/keyway/releases/latest/download/Keyway-Windows-arm64.zip)) and unzip it.
2. Run **`Keyway.exe`**. If SmartScreen warns about an unrecognised app, click
   **More info → Run anyway** (the build is unsigned).
3. Enter your **provider**, **API key**, and **model(s)** → **Install**.
4. Claude Desktop restarts using your models. A **K** icon in the tray shows
   `Connected` / `Not running`.

To remove: open Keyway again (click the tray icon) → **Remove**.

What it writes:

```
%LOCALAPPDATA%\Keyway\          Keyway.exe, gateway, node.exe, config.json, key (ACL: you only), gateway.log
HKCU\...\CurrentVersion\Run     value "Keyway" — starts the tray app at login (no admin needed)
%LOCALAPPDATA%\Claude-3p\       Claude Desktop gateway profile
```

On Windows the tray app (`Keyway.exe --background`) is the gateway's supervisor:
it runs `node.exe gateway.mjs` without a console window and restarts it if it
exits, which is what launchd does on macOS. **Quit Keyway** in the tray menu
stops the gateway.

## Install from source

Requires macOS with `swiftc` (Xcode Command Line Tools) and Node.

```sh
git clone https://github.com/shivamtiwari3/keyway
cd keyway
make build            # -> dist/Keyway.app and dist/Keyway-Setup.zip (universal)
open "dist/Keyway.app"
```

Builds are universal (arm64 + x86_64) and bundle a universal Node runtime.
To sign and notarize for distribution, set:

```sh
CODESIGN_IDENTITY="Developer ID Application: You (TEAMID)" \
APPLE_ID="you@example.com" TEAM_ID="TEAMID" APPLE_PASSWORD="app-specific-password" \
./make-dist.sh
```

**Windows** needs nothing beyond Windows itself: `Keyway.exe` is compiled with
the C# compiler that ships with .NET Framework 4.8, and Node is downloaded
(and checksum-verified) from nodejs.org.

```powershell
git clone https://github.com/shivamtiwari3/keyway
cd keyway
powershell -ExecutionPolicy Bypass -File make-dist.ps1   # -> dist\Keyway\ and dist\Keyway-Windows-x64.zip
.\dist\Keyway\Keyway.exe
```

Pass `-Arch arm64` for an ARM64 build. Set `SIGNTOOL_CERT` / `SIGNTOOL_PASSWORD`
to Authenticode-sign `Keyway.exe`.

Or drive the pieces directly:

```sh
node gateway.mjs      # reads ./config.json
node setup.mjs install --key KEY --provider-name OpenAI \
  --upstream https://api.openai.com/v1 --api auto --models gpt-4o-mini
node setup.mjs uninstall
node setup.mjs status
```

---

## Configuration

`setup.mjs` writes `~/Library/Application Support/Keyway/config.json`
(Windows: `%LOCALAPPDATA%\Keyway\config.json`):

```jsonc
{
  "host": "127.0.0.1",
  "port": 8788,
  "api": "auto",                 // auto | anthropic | openai (auto = detect)
  "providerName": "OpenAI",
  "upstream": "https://api.openai.com/v1",
  "apiKeyFile": "…/Keyway/key",
  "defaultModel": "gpt-4o-mini",
  "models": [ { "name": "claude-opus-4-5", "label": "OpenAI · gpt-4o-mini", "tier": "opus" } ],
  "modelMap": { "claude-opus-4-5": "gpt-4o-mini" }
}
```

**Why the `/v1/models` are named `claude-*`:** Claude Desktop only accepts
gateway routes that reference an Anthropic model name, so Keyway advertises
routes like `claude-opus-4-5` / `claude-sonnet-4-5` and maps each one to your real
provider model via `modelMap`. The picker shows your friendly `label`.

## How it works

| File | Role |
|---|---|
| `gateway.mjs` | Loopback HTTP server speaking the Anthropic Messages API to Claude Desktop; forwards to your provider (pass-through or translate). Answers `/health`, `/v1/models`, `/v1/messages`, `/v1/messages/count_tokens`. |
| `setup.mjs` | Installs/uninstalls: bundles the gateway, writes the Claude Desktop "3p" gateway profile, registers the login service (launchd on macOS, HKCU `Run` on Windows). |
| `app/main.swift` | macOS: SwiftUI setup window + menu bar status item. |
| `app/windows/Keyway.cs` | Windows: WinForms setup window, tray status icon, and gateway supervisor. |
| `make-dist.sh` / `make-dist.ps1` | Build `Keyway-Setup.zip` (macOS) / `Keyway-Windows-<arch>.zip` (Windows). |
| `test/gateway.smoke.mjs` | Dependency-free end-to-end test of the gateway against fake OpenAI/Anthropic upstreams. |

## Security & privacy

See [SECURITY.md](SECURITY.md) to report a vulnerability.

- Binds **loopback only** (`127.0.0.1`).
- API key at `~/Library/Application Support/Keyway/key` (`chmod 600`) or
  `%LOCALAPPDATA%\Keyway\key` (ACL restricted to your user); sent only to your
  configured endpoint.
- **No telemetry.** `Copy Diagnostics` copies status + the log path (never the key).

## Troubleshooting

| Symptom | Fix |
|---|---|
| Menu bar shows `Off` | Gateway isn't running — check `~/Library/Application Support/Keyway/gateway.log`, then reopen Keyway and reinstall. |
| `401` from provider | Wrong or missing API key. |
| Models missing in picker | Claude Desktop removes routes that aren't Anthropic-named; Keyway names them `claude-*` automatically. |
| Gateway won't start | Port `8788` in use — change `port` in `config.json` and the profile URL. |
| Gatekeeper blocks the app | Right-click → Open, or sign/notarize with your own Developer ID. |
| Windows: tray icon grey / `Not running` | Check `%LOCALAPPDATA%\Keyway\gateway.log` (tray → Open Log), then tray → Restart Gateway. If the tray icon is gone, run `%LOCALAPPDATA%\Keyway\Keyway.exe --background`. |
| Windows: SmartScreen blocks the app | More info → Run anyway, or sign `Keyway.exe` (`SIGNTOOL_CERT`). |

## FAQ

<details><summary>Is my key safe?</summary>

Yes. Loopback only, stored locally with mode 600, sent only to your endpoint. No telemetry.
</details>

<details><summary>Do I need Node or Xcode?</summary>

No. The release app bundles its own runtime. Right-click → Open (macOS) or run
`Keyway.exe` (Windows), paste your key, done.
</details>

<details><summary>Does it work offline / with local models?</summary>

Yes — point it at a local OpenAI-compatible server (Ollama, llama.cpp, vLLM) via Custom.
</details>

<details><summary>Why restart Claude Desktop?</summary>

It reads its provider profile only at startup.
</details>

## Contributing

Issues and PRs welcome. Please run `node test/gateway.smoke.mjs` and `make build`
(macOS) or `make-dist.ps1` (Windows) before opening a PR, and keep the
gateway dependency-free.

## License

[MIT](LICENSE) © Keyway contributors.

> Not affiliated with Anthropic. "Claude" is a trademark of Anthropic, PBC.
