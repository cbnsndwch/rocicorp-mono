//@ts-check

import * as fs from 'node:fs';
import * as os from 'node:os';
import {execSync} from 'node:child_process';
import * as path from 'path';

/** @param {string[]} parts */
function basePath(...parts) {
  return path.join(process.cwd(), ...parts);
}

/**
 * @param {string} command
 * @param {{stdio?:'inherit'|'pipe'|undefined, cwd?:string|undefined}|undefined} [options]
 */
function execute(command, options) {
  console.log(`Executing: ${command}`);
  return execSync(command, {stdio: 'inherit', ...options});
}

/**
 * @param {fs.PathOrFileDescriptor} packagePath
 */
function getPackageData(packagePath) {
  return JSON.parse(fs.readFileSync(packagePath, 'utf8'));
}

/**
 * @param {fs.PathOrFileDescriptor} packagePath
 * @param {any} data
 */
function writePackageData(packagePath, data) {
  fs.writeFileSync(packagePath, JSON.stringify(data, null, 2));
}

/**
 * @param {string} version
 * @param {string} hash
 */
function bumpCanaryVersion(version, hash) {
  const match = version.match(/^(\d+)\.(\d+)\./);
  if (!match) {
    throw new Error('Cannot parse existing version');
  }

  const [, major, minor] = match;
  const [year, month, day, hour, minute] = new Date()
    .toISOString()
    .split(/[^\d]/);
  const ts = `${year}${month}${day}${hour}${minute}`;

  return `${major}.${minor}.${ts}+${hash}`;
}

try {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-build-'));
  execute(`git clone --depth 1 git@github.com:rocicorp/mono.git ${tempDir}`);
  process.chdir(tempDir);
  //installs turbo and other build dependencies
  execute('npm install');
  const REFLECT_PACKAGE_JSON_PATH = basePath(
    'packages',
    'reflect',
    'package.json',
  );

  const changes = execute('git diff HEAD .', {stdio: 'pipe'}).toString().trim();
  if (changes.length > 0) {
    console.error('There are uncommitted changes, cannot continue');
    process.exit(1);
  }

  const hash = execute('git rev-parse HEAD', {stdio: 'pipe'})
    .toString()
    .trim()
    .substring(0, 6);
  const currentPackageData = getPackageData(REFLECT_PACKAGE_JSON_PATH);
  const nextCanaryVersion = bumpCanaryVersion(currentPackageData.version, hash);
  currentPackageData.version = nextCanaryVersion;

  const tagName = `reflect/v${nextCanaryVersion}`;
  const branchName = `release_reflect/v${nextCanaryVersion}`;
  execute(`git checkout -b ${branchName} origin/main`);

  writePackageData(REFLECT_PACKAGE_JSON_PATH, currentPackageData);

  const dependencyPaths = [
    basePath('apps', 'reflect.net', 'package.json'),
    basePath('mirror', 'mirror-cli', 'package.json'),
  ];

  dependencyPaths.forEach(p => {
    const data = getPackageData(p);
    if (data.dependencies && data.dependencies['@rocicorp/reflect']) {
      data.dependencies['@rocicorp/reflect'] = nextCanaryVersion;
      writePackageData(p, data);
    }
  });

  execute('npm install');
  execute('npm run format');
  execute('npx syncpack');
  execute('git status');
  execute('git add package.json');
  execute('git add **/package.json');
  execute('git add package-lock.json');
  execute(`git commit -m "Bump version to ${nextCanaryVersion}"`);

  execute('npm publish --tag=canary', {cwd: basePath('packages', 'reflect')});

  execute(`git tag ${tagName}`);
  execute(`git push origin ${tagName}`);
  execute(`git checkout main`);
  execute(`git pull`);
  execute(`git merge ${branchName}`);
  console.log(`please do the following:`);
  console.log(`1. cd ${tempDir}`);
  console.log(
    '2. Review the head commit with `git show HEAD`. Note: If work has happened on main since this release began, HEAD will be a merge commit. Otherwise it will be a normal commit.',
  );
  console.log(`3. git push origin main`);
  console.log(`4. cd -`);
} catch (error) {
  console.error(`Error during execution: ${error}`);
  process.exit(1);
}