#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { configTemplate, defaultConfigPath, loadConfig } from './config.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const USAGE = `qq-notifier ${pkg.version}

Usage:
  qqn setup   [--config PATH] [--force]   Create the QQ bot (QR scan) and capture the target openid
  qqn server  [--config PATH]             Run the notification server
  qqn send    TEXT [--key K] [--config PATH]
                                          Enqueue a message through the local server
  qqn status  [--config PATH]             Print the server health JSON
  qqn resume  [--config PATH]             Clear halt/cooldown after a failure streak
  qqn --config-template                   Print a commented configuration template
  qqn --help | --version

Default config path: ${defaultConfigPath()}
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const options = { command: null, text: null, configPath: null, force: false, key: null, help: false, version: false, template: false };
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--version' || arg === '-V') {
      options.version = true;
    } else if (arg === '--config-template') {
      options.template = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--config' || arg === '--key') {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`${arg} requires a value`);
      if (arg === '--config') options.configPath = value;
      else options.key = value;
      i += 1;
    } else if (arg.startsWith('--config=')) {
      options.configPath = arg.slice('--config='.length);
    } else if (arg.startsWith('--key=')) {
      options.key = arg.slice('--key='.length);
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  options.command = positionals[0] ?? null;
  options.text = positionals[1] ?? null;
  if (positionals.length > 2) throw new UsageError(`unexpected argument: ${positionals[2]}`);
  return options;
}

function resolveConfigPath(options) {
  return options.configPath ?? defaultConfigPath();
}

async function httpCall(config, path, { method = 'GET', body = null } = {}) {
  const headers = {};
  if (config.server.token) headers['x-auth-token'] = config.server.token;
  if (body !== null) headers['content-type'] = 'application/json';
  const url = `http://127.0.0.1:${config.server.port}${path}`;
  let response;
  try {
    response = await fetch(url, { method, headers, body: body === null ? undefined : JSON.stringify(body) });
  } catch (err) {
    throw new Error(`cannot reach the server at ${url}: ${err.message}. Is \`qqn server\` running?`);
  }
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  return { status: response.status, payload };
}

async function runSetupCommand(options) {
  const { runSetup } = await import('./setup.js');
  await runSetup({ configPath: resolveConfigPath(options), force: options.force });
}

async function runServerCommand(options) {
  const { runServer } = await import('./server.js');
  await runServer({ configPath: resolveConfigPath(options) });
}

async function runSendCommand(options) {
  if (options.text === null || options.text === '') throw new UsageError('send requires a non-empty TEXT argument');
  const config = loadConfig(resolveConfigPath(options));
  const body = { text: options.text };
  if (options.key !== null) body.key = options.key;
  const { status, payload } = await httpCall(config, '/notify', { method: 'POST', body });
  if (status !== 202) {
    console.error(`enqueue failed: HTTP ${status} ${JSON.stringify(payload)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`queued ${payload.id} at ${new Date(payload.queued_at).toISOString()}`);
}

async function runStatusCommand(options) {
  const config = loadConfig(resolveConfigPath(options));
  const { status, payload } = await httpCall(config, '/health');
  console.log(JSON.stringify(payload, null, 2));
  if (status !== 200) process.exitCode = 1;
}

async function runResumeCommand(options) {
  const config = loadConfig(resolveConfigPath(options));
  const { status, payload } = await httpCall(config, '/resume', { method: 'POST' });
  if (status !== 200) {
    console.error(`resume failed: HTTP ${status} ${JSON.stringify(payload)}`);
    process.exitCode = 1;
    return;
  }
  console.log('worker resumed');
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }

  if (options.template) {
    process.stdout.write(configTemplate());
    return;
  }
  if (options.version) {
    console.log(pkg.version);
    return;
  }
  if (options.help || options.command === null) {
    process.stdout.write(USAGE);
    return;
  }

  try {
    switch (options.command) {
      case 'setup':
        await runSetupCommand(options);
        break;
      case 'server':
        await runServerCommand(options);
        break;
      case 'send':
        await runSendCommand(options);
        break;
      case 'status':
        await runStatusCommand(options);
        break;
      case 'resume':
        await runResumeCommand(options);
        break;
      default:
        throw new UsageError(`unknown command: ${options.command}`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${err.message}\n\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    console.error(err.message);
    process.exitCode = 1;
  }
}

main();
