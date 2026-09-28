#!/usr/bin/env node
// Installs / removes the Keyway local gateway for Claude Desktop. No dependencies.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RES = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const UID = process.getuid();
const SUPPORT = path.join(HOME, 'Library/Application Support/Keyway');
const ROOT3P = path.join(HOME, 'Library/Application Support/Claude-3p');
const LIB = path.join(ROOT3P, 'configLibrary');
const META = path.join(LIB, '_meta.json');
const SETTINGS = path.join(ROOT3P, 'claude_desktop_config.json');
const LABEL = 'dev.keyway.gateway';
const PLIST = path.join(HOME, 'Library/LaunchAgents', LABEL + '.plist');
const PROFILE_ID = '7a57ad9d-8708-5e0e-9a63-2d50f6438c90';
const PORT = Number(process.env.PORT || 8788);
const arg = (name, def = '') => { const i = process.argv.indexOf('--' + name); return i >= 0 ? (process.argv[i + 1] ?? '') : def; };

// Generic BYOK: any provider, any key.
const PROVIDER_NAME = arg('provider-name', 'Provider');
const UPSTREAM = (arg('upstream', 'https://api.openai.com/v1')).replace(/\/+$/, '');
const API_ARG = arg('api', 'auto'); // auto | anthropic | openai — the gateway resolves "auto"
const MODEL_LIST = arg('models', 'gpt-4o-mini').split(',').map((s) => s.trim()).filter(Boolean);

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

const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} };
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8') || 'null') ?? d; } catch { return d; } };
const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };
const backup = (p) => { if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak-keyway'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealth(ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) return true; } catch {}
    await sleep(300);
  }
  return false;
}

function plist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
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
}

function restartClaude() {
  sh('/usr/bin/killall', ['Claude']);
  const end = Date.now() + 4000;
  while (Date.now() < end && sh('/usr/bin/pgrep', ['-f', 'Claude.app/Contents/MacOS/Claude']).trim()) sleep(200);
  sh('/usr/bin/open', ['-a', 'Claude']);
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
  meta.entries = (meta.entries || []).filter((e) => e && e.id !== PROFILE_ID);
  meta.entries.push({ id: PROFILE_ID, name: 'Keyway', provider: 'gateway' });
  meta.appliedId = PROFILE_ID;
  delete meta.hybridPointer;
  writeJson(META, meta);
  const s = readJson(SETTINGS, {});
  s.deploymentMode = '3p';
  writeJson(SETTINGS, s);
}

async function install(key) {
  if (!fs.existsSync(path.join(RES, 'node'))) {
    throw new Error('bundled runtime not found — build first with `make build`, or use Keyway.app');
  }
  fs.mkdirSync(SUPPORT, { recursive: true });
  fs.copyFileSync(path.join(RES, 'gateway.mjs'), path.join(SUPPORT, 'gateway.mjs'));
  fs.copyFileSync(path.join(RES, 'node'), path.join(SUPPORT, 'node'));
  fs.chmodSync(path.join(SUPPORT, 'node'), 0o755);
  sh('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', SUPPORT]);
  sh('/usr/bin/codesign', ['--force', '--sign', '-', path.join(SUPPORT, 'node')]);
  const keyPath = path.join(SUPPORT, 'key');
  fs.writeFileSync(keyPath, key.trim() + '\n', { mode: 0o600 });
  try { fs.chmodSync(keyPath, 0o600); } catch {}
  writeJson(path.join(SUPPORT, 'config.json'), {
    host: '127.0.0.1', port: PORT, api: API_ARG, providerName: PROVIDER_NAME, upstream: UPSTREAM,
    apiKeyFile: path.join(SUPPORT, 'key'),
    defaultModel: MODEL_LIST[0],
    models: MODELS.map((m) => ({ name: m.name, label: m.label, tier: m.tier })),
    modelMap: MODEL_MAP, log: true,
  });
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(PLIST, plist());
  sh('/bin/launchctl', ['bootout', `gui/${UID}/${LABEL}`]);
  await sleep(300);
  sh('/bin/launchctl', ['bootstrap', `gui/${UID}`, PLIST]);
  if (!(await waitHealth())) throw new Error('gateway did not start — see gateway.log in ' + SUPPORT);
  writeProfile();
  restartClaude();
}

function uninstall() {
  sh('/bin/launchctl', ['bootout', `gui/${UID}/${LABEL}`]);
  rm(PLIST);
  rm(path.join(LIB, PROFILE_ID + '.json'));
  const meta = readJson(META, null);
  if (meta) {
    meta.entries = (meta.entries || []).filter((e) => e && e.id !== PROFILE_ID);
    if (meta.appliedId === PROFILE_ID) meta.appliedId = (meta.entries[0] || {}).id || null;
    writeJson(META, meta);
  }
  const s = readJson(SETTINGS, {});
  if (s.deploymentMode === '3p') { s.deploymentMode = '1p'; writeJson(SETTINGS, s); }
  rm(SUPPORT);
  restartClaude();
}

function status() {
  const installed = fs.existsSync(path.join(SUPPORT, 'key')) && fs.existsSync(PLIST);
  console.log(installed ? 'installed' : 'not-installed');
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
  } else {
    console.error('usage: setup.mjs install --key <key> | uninstall | status');
    process.exit(2);
  }
} catch (e) {
  console.error(e.message || String(e));
  process.exit(1);
}
