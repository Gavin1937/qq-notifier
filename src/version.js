import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

if (typeof packageJson.version !== 'string' || packageJson.version.trim() === '') {
  throw new Error('package.json is missing a version string');
}

export const version = packageJson.version;
