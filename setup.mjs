#!/usr/bin/env node
// Installs / removes the Keyway local gateway for Claude Desktop. No dependencies.
// Supports macOS (launchd) and Windows (Keyway.exe tray supervisor + HKCU Run key).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RES = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const IS_WIN = process.platform === 'win32';
const PROFILE_ID = '7a57ad9d-8708-5e0e-9a63-2d50f6438c90';
const PORT = Number(process.env.PORT || 8788);
const arg = (name, def = '') => { const i = process.argv.indexOf('--' + name); return i >= 0 ? (process.argv[i + 1] ?? '') : def; };
const flag = (name) => process.argv.includes('--' + name);

// Generic BYOK: any provider, any key.
const PROVIDER_NAME = arg('provider-name', 'Provider');
const UPSTREAM = (arg('upstream', 'https://api.openai.com/v1')).replace(/\/+$/, '');
const API_ARG = arg('api', 'auto'); // auto | anthropic | openai — the gateway resolves "auto"
const MODEL_LIST = arg('models', 'gpt-4o-mini').split(',').map((s) => s.trim()).filter(Boolean);
// --no-restart: leave Claude Desktop alone (the caller restarts it later).
// --no-autostart: don't register a login item (useful for testing).
const NO_RESTART = flag('no-restart');
const NO_AUTOSTART = flag('no-autostart');

// Claude Desktop only accepts gateway model routes that reference an Anthropic
// model name (e.g. claude-sonnet-4-5), so advertise those and map each route to
// the real provider model in the gateway.
const ROUTES = [
  { id: 'claude-opus-4-5', tier: 'opus' },
  { id: 'claude-sonnet-4-5', tier: 'sonnet' },
  { id: 'claude-haiku-4-5', tier: 'haiku' },
  { id: 'claude-3-5-sonnet-20241022', tier: 'sonnet' },
  { id: 'claude-3-5-haiku-20241022', tier: 'haiku' },
  { id: 'claude-3-opus-20240229', tier: 'opus' },
  { id: 'claude-3-haiku-20240307', tier: 'haiku' },
  { id: 'claude-sonnet-4-20250514', tier: 'sonnet' },
];
if (MODEL_LIST.length > ROUTES.length) {
  console.warn(`[setup] only the first ${ROUTES.length} models can be exposed; ignoring: ${MODEL_LIST.slice(ROUTES.length).join(', ')}`);
}
const MODELS = MODEL_LIST.slice(0, ROUTES.length).map((ref, i) => ({
  name: ROUTES[i].id,
  ref,
  label: `${PROVIDER_NAME} · ${ref}`,
  tier: ROUTES[i].tier,
}));
const MODEL_MAP = Object.fromEntries(MODELS.map((m) => [m.name, m.ref]));

const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8') || 'null') ?? d; } catch { return d; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };
const backup = (p) => { if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak-keyway'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -------------------- macOS --------------------

function darwin() {
  const SUPPORT = path.join(HOME, 'Library/Application Support/Keyway');
  const LABEL = 'dev.keyway.gateway';
  const PLIST = path.join(HOME, 'Library/LaunchAgents', LABEL + '.plist');
  const APP_LABEL = 'dev.keyway.app';
  const APP_PLIST = path.join(HOME, 'Library/LaunchAgents', APP_LABEL + '.plist');
  const APP_EXE = path.resolve(RES, '..', 'MacOS', 'Keyway'); // present when run from Keyway.app
  const domain = () => `gui/${process.getuid()}`;

  const plist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${path.join(SUPPORT, 'node')}</string><string>${path.join(SUPPORT, 'gateway.mjs')}</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>KEYWAY_CONFIG</key><string>${path.join(SUPPORT, 'config.json')}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(SUPPORT, 'gateway.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(SUPPORT, 'gateway.log')}</string>
</dict>
</plist>
`;

  const appPlist = () => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${APP_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${APP_EXE}</string></array>
  <key>RunAtLoad</key><true/>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;

  return {
    SUPPORT: process.env.KEYWAY_SUPPORT_DIR || SUPPORT,
    ROOT3P: process.env.KEYWAY_CLAUDE_3P_DIR || path.join(HOME, 'Library/Application Support/Claude-3p'),
    NODE: 'node',

    copyRuntime(support) {
      fs.copyFileSync(path.join(RES, 'gateway.mjs'), path.join(support, 'gateway.mjs'));
      fs.copyFileSync(path.join(RES, 'node'), path.join(support, 'node'));
      fs.chmodSync(path.join(support, 'node'), 0o755);
      sh('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', support]);
      sh('/usr/bin/codesign', ['--force', '--sign', '-', path.join(support, 'node')]);
    },

    protectKey(keyPath) { try { fs.chmodSync(keyPath, 0o600); } catch {} },

    async startGateway() {
      fs.mkdirSync(path.dirname(PLIST), { recursive: true });
      fs.writeFileSync(PLIST, plist());
      sh('/bin/launchctl', ['bootout', `${domain()}/${LABEL}`]);
      await sleep(300);
      sh('/bin/launchctl', ['bootstrap', domain(), PLIST]);
    },

    stopGateway() {
      sh('/bin/launchctl', ['bootout', `${domain()}/${LABEL}`]);
      rm(PLIST);
    },

    // Keep the menu bar icon present across logins. Only when run from the app bundle.
    installLoginItem() {
      if (!fs.existsSync(APP_EXE)) return false;
      fs.mkdirSync(path.dirname(APP_PLIST), { recursive: true });
      fs.writeFileSync(APP_PLIST, appPlist());
      sh('/bin/launchctl', ['bootout', `${domain()}/${APP_LABEL}`]);
      sh('/bin/launchctl', ['bootstrap', domain(), APP_PLIST]);
      return true;
    },

    removeLoginItem() {
      sh('/bin/launchctl', ['bootout', `${domain()}/${APP_LABEL}`]);
      rm(APP_PLIST);
    },

    isInstalled(support) { return fs.existsSync(path.join(support, 'key')) && fs.existsSync(PLIST); },

    restartClaude() {
      sh('/usr/bin/killall', ['Claude']);
      const end = Date.now() + 4000;
      while (Date.now() < end && sh('/usr/bin/pgrep', ['-f', 'Claude.app/Contents/MacOS/Claude']).trim()) sleep(200);
      sh('/usr/bin/open', ['-a', 'Claude']);
    },

    removeSupport(support) { rm(support); },
  };
}

// -------------------- Windows --------------------

function win32() {
  const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
  const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const RUN_VALUE = 'Keyway';
  const APP_EXE = path.resolve(RES, '..', 'Keyway.exe'); // present when run from the Keyway folder
  const SUPPORT = process.env.KEYWAY_SUPPORT_DIR || path.join(LOCAL, 'Keyway');
  const SUP_EXE = path.join(SUPPORT, 'Keyway.exe');
  // Pid files let us stop exactly what we started (and nothing else).
  const PIDS = { supervisor: ['keyway.pid', 'keyway.exe'], gateway: ['gateway.pid', 'node.exe'] };
  const ps = (script) => sh('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);

  function killPidFile(file, image) {
    const p = path.join(SUPPORT, file);
    const pid = Number((() => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } })());
    rm(p);
    if (!pid) return;
    // Guard against pid reuse: only kill if the pid still belongs to the expected image.
    const row = sh('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']).toLowerCase();
    if (row.includes(`"${image}"`)) sh('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
  }

  function launcher() {
    return fs.existsSync(SUP_EXE) ? `"${SUP_EXE}" --background` : null;
  }

  return {
    SUPPORT,
    ROOT3P: process.env.KEYWAY_CLAUDE_3P_DIR || path.join(LOCAL, 'Claude-3p'), // verified in Claude Desktop's app.asar
    NODE: 'node.exe',

    copyRuntime(support) {
      // When re-run from the installed copy (tray → Open Setup), RES is SUPPORT and
      // node.exe is the running process: nothing to copy.
      if (path.resolve(RES).toLowerCase() === path.resolve(support).toLowerCase()) return;
      for (const f of ['gateway.mjs', 'setup.mjs', 'node.exe']) fs.copyFileSync(path.join(RES, f), path.join(support, f));
      // Install the tray app too, so the login item has a stable path even if the download folder is cleaned.
      if (fs.existsSync(APP_EXE) && path.resolve(APP_EXE) !== path.resolve(SUP_EXE)) fs.copyFileSync(APP_EXE, SUP_EXE);
    },

    protectKey(keyPath) {
      // Equivalent of chmod 600: drop inherited ACEs, grant only the current user.
      const user = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${os.userInfo().username}` : os.userInfo().username;
      sh('icacls.exe', [keyPath, '/inheritance:r', '/grant:r', `${user}:F`]);
    },

    async startGateway() {
      if (fs.existsSync(SUP_EXE)) {
        // The tray app supervises node.exe (hidden window, restart on crash).
        spawn(SUP_EXE, ['--background'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        return;
      }
      // Source checkout without Keyway.exe: run the gateway directly (no keep-alive).
      const logFd = fs.openSync(path.join(SUPPORT, 'gateway.log'), 'a');
      const child = spawn(path.join(SUPPORT, 'node.exe'), [path.join(SUPPORT, 'gateway.mjs')], {
        detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true,
        env: { ...process.env, KEYWAY_CONFIG: path.join(SUPPORT, 'config.json') },
      });
      fs.writeFileSync(path.join(SUPPORT, PIDS.gateway[0]), String(child.pid));
      child.unref();
      fs.closeSync(logFd);
    },

    stopGateway() {
      killPidFile(...PIDS.supervisor);
      killPidFile(...PIDS.gateway);
    },

    installLoginItem() {
      const cmd = launcher();
      if (!cmd) return false;
      sh('reg.exe', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', cmd, '/f']);
      return true;
    },

    removeLoginItem() { sh('reg.exe', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']); },

    isInstalled(support) { return fs.existsSync(path.join(support, 'key')) && fs.existsSync(path.join(support, 'config.json')); },

    restartClaude() {
      // Never kill by image name: the Claude Code CLI is also "claude.exe".
      // Match Claude Desktop by install path (MSIX package or legacy Squirrel install).
      ps(`
$ErrorActionPreference = 'SilentlyContinue'
$re = '\\\\WindowsApps\\\\(Claude|AnthropicPBC\\.Claude)_[^\\\\]+\\\\app\\\\Claude\\.exe$|\\\\AnthropicClaude\\\\(app-[^\\\\]+\\\\)?claude\\.exe$'
Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.ExecutablePath -match $re } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
$end = (Get-Date).AddSeconds(5)
while ((Get-Date) -lt $end -and (Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Where-Object { $_.ExecutablePath -match $re })) { Start-Sleep -Milliseconds 200 }
$pkg = Get-AppxPackage | Where-Object { $_.Name -in @('Claude','AnthropicPBC.Claude') } | Select-Object -First 1
if ($pkg) { Start-Process "shell:AppsFolder\\$($pkg.PackageFamilyName)!Claude"; exit }
$legacy = Join-Path $env:LOCALAPPDATA 'AnthropicClaude\\claude.exe'
if (Test-Path $legacy) { Start-Process $legacy }
`);
    },

    removeSupport(support) {
      rm(support);
      // If we were launched from the installed Keyway.exe it is still locked; delete it once it exits.
      if (fs.existsSync(support)) {
        // windowsVerbatimArguments: cmd.exe doesn't understand Node's \" escaping.
        spawn('cmd.exe', ['/d', '/c', `ping -n 4 127.0.0.1 >nul & rmdir /s /q "${support}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
      }
    },
  };
}

// -------------------- shared --------------------

const P = IS_WIN ? win32() : darwin();
const SUPPORT = P.SUPPORT;
const LIB = path.join(P.ROOT3P, 'configLibrary');
const META = path.join(LIB, '_meta.json');
const SETTINGS = path.join(P.ROOT3P, 'claude_desktop_config.json');

async function waitHealth(ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) return true; } catch {}
    await sleep(300);
  }
  return false;
}

function writeProfile() {
  fs.mkdirSync(LIB, { recursive: true });
  backup(META); backup(SETTINGS);
  writeJson(path.join(LIB, PROFILE_ID + '.json'), {
    inferenceProvider: 'gateway',
    inferenceGatewayBaseUrl: `http://127.0.0.1:${PORT}`,
    inferenceCredentialKind: 'static',
    inferenceGatewayApiKey: 'keyway-local',
    inferenceGatewayAuthScheme: 'bearer',
    chatTabEnabled: true,
    inferenceModels: MODELS.map((m) => ({ name: m.name, labelOverride: m.label, anthropicFamilyTier: m.tier, isFamilyDefault: true })),
  });
  const meta = readJson(META, {});
  // Drop our old entry and any dead references (profile file missing) so Claude
  // Desktop doesn't warn about stale entries left by prior installs.
  meta.entries = (meta.entries || [])
    .filter((e) => e && e.id !== PROFILE_ID)
    .filter((e) => fs.existsSync(path.join(LIB, e.id + '.json')));
  meta.entries.push({ id: PROFILE_ID, name: 'Keyway', provider: 'gateway' });
  meta.appliedId = PROFILE_ID;
  delete meta.hybridPointer;
  writeJson(META, meta);
  const s = readJson(SETTINGS, {});
  s.deploymentMode = '3p';
  writeJson(SETTINGS, s);
}

async function install(key) {
  if (!fs.existsSync(path.join(RES, P.NODE))) {
    throw new Error('bundled runtime not found — build first with `make build` / make-dist.ps1, or use the Keyway app');
  }
  fs.mkdirSync(SUPPORT, { recursive: true });
  P.stopGateway(); // release files held by a running gateway before overwriting them
  P.copyRuntime(SUPPORT);
  const keyPath = path.join(SUPPORT, 'key');
  fs.writeFileSync(keyPath, key.trim() + '\n', { mode: 0o600 });
  P.protectKey(keyPath);
  writeJson(path.join(SUPPORT, 'config.json'), {
    host: '127.0.0.1', port: PORT, api: API_ARG, providerName: PROVIDER_NAME, upstream: UPSTREAM,
    apiKeyFile: keyPath,
    defaultModel: MODEL_LIST[0],
    models: MODELS.map((m) => ({ name: m.name, label: m.label, tier: m.tier })),
    modelMap: MODEL_MAP, log: true,
  });
  await P.startGateway();
  if (!(await waitHealth())) throw new Error('gateway did not start — see gateway.log in ' + SUPPORT);
  writeProfile();
  if (!NO_AUTOSTART && P.installLoginItem()) console.log('Keyway set to launch at login');
  if (!NO_RESTART) P.restartClaude();
}

function uninstall() {
  P.stopGateway();
  P.removeLoginItem();
  rm(path.join(LIB, PROFILE_ID + '.json'));
  const meta = readJson(META, null);
  if (meta) {
    meta.entries = (meta.entries || []).filter((e) => e && e.id !== PROFILE_ID);
    if (meta.appliedId === PROFILE_ID) meta.appliedId = (meta.entries[0] || {}).id || null;
    writeJson(META, meta);
  }
  const s = readJson(SETTINGS, {});
  if (s.deploymentMode === '3p') { s.deploymentMode = '1p'; writeJson(SETTINGS, s); }
  P.removeSupport(SUPPORT);
  if (!NO_RESTART) P.restartClaude();
}

function status() {
  console.log(P.isInstalled(SUPPORT) ? 'installed' : 'not-installed');
}

const [cmd, ...rest] = process.argv.slice(2);
const keyArg = (() => { const i = rest.indexOf('--key'); return i >= 0 ? rest[i + 1] : ''; })();
const existingKey = () => { try { return fs.readFileSync(path.join(SUPPORT, 'key'), 'utf8').trim(); } catch { return ''; } };

try {
  if (cmd === 'install') {
    const key = keyArg || existingKey();
    if (!key) throw new Error('no API key provided');
    await install(key);
    console.log('installed');
  } else if (cmd === 'uninstall') {
    uninstall();
    console.log('uninstalled');
  } else if (cmd === 'status') {
    status();
  } else if (cmd === 'restart-claude') {
    P.restartClaude();
    console.log('restarted');
  } else {
    console.error('usage: setup.mjs install --key <key> [--no-restart] [--no-autostart] | uninstall [--no-restart] | status | restart-claude');
    process.exit(2);
  }
} catch (e) {
  console.error(e.message || String(e));
  process.exit(1);
}
