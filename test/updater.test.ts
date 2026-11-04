import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  compareVersions,
  downloadAsset,
  fetchLatestRelease,
  isNewer,
  macSwapScript,
  notesFromBody,
  parseRelease,
  parseVersion,
  pickAsset,
  relaunchAfterExit,
  swapAppImage,
} from '../src/main/update-core.ts';

test('parseVersion / compareVersions are numeric, not lexical', () => {
  assert.deepEqual(parseVersion('v1.0.42'), [1, 0, 42]);
  assert.deepEqual(parseVersion('1.2.3-beta.1'), [1, 2, 3]);
  assert.equal(parseVersion('latest-build'), null);
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
  assert.equal(compareVersions('1.0.9', '1.0.10'), -1);
  assert.equal(compareVersions('v1.0.3', '1.0.3'), 0);
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.0.0', '0.1.999'), 1);
  assert.equal(compareVersions('garbage', '0.0.1'), -1);
  assert.ok(isNewer('1.0.100', '1.0.99'));
  assert.ok(!isNewer('1.0.5', '1.0.5'));
  assert.ok(!isNewer('0.1.0', '1.0.3'));
});

const ASSETS = [
  'Clickity-mac-arm64.dmg',
  'Clickity-mac-arm64.zip',
  'Clickity-mac-x64.dmg',
  'Clickity-mac-x64.zip',
  'Clickity-win-x64.exe',
  'Clickity-linux-x86_64.AppImage',
  'Clickity-linux-amd64.deb',
  'build.json',
].map((name) => ({ name, size: 1, url: `https://x/${name}` }));

test('pickAsset: this platform/arch', () => {
  assert.equal(pickAsset(ASSETS, 'darwin', 'arm64')?.name, 'Clickity-mac-arm64.zip');
  assert.equal(pickAsset(ASSETS, 'darwin', 'x64')?.name, 'Clickity-mac-x64.zip');
  assert.equal(pickAsset(ASSETS, 'win32', 'x64')?.name, 'Clickity-win-x64.exe');
  assert.equal(pickAsset(ASSETS, 'linux', 'x64', '/home/me/Clickity.AppImage')?.name, 'Clickity-linux-x86_64.AppImage');
  assert.equal(pickAsset(ASSETS, 'linux', 'x64', undefined)?.name, 'Clickity-linux-amd64.deb');
  assert.equal(pickAsset(ASSETS, 'linux', 'arm64', '/x.AppImage'), null);
  assert.equal(pickAsset(ASSETS, 'win32', 'arm64'), null);
  assert.equal(pickAsset(ASSETS, 'freebsd', 'x64'), null);
  assert.equal(pickAsset(ASSETS.filter((a) => !a.name.endsWith('.zip')), 'darwin', 'arm64'), null);
});

test('parseRelease: tag → version, notes before the install section', () => {
  const r = parseRelease({
    tag_name: 'v1.0.42',
    html_url: 'https://github.com/x/releases/tag/v1.0.42',
    body: '### changes\n- add updater\n- fix mic\n\n<!-- install -->\ndownload the installer for your computer:\n- mac',
    assets: [{ name: 'a.zip', size: 10, browser_download_url: 'https://x/a.zip' }, { bogus: true }],
  });
  assert.equal(r.version, '1.0.42');
  assert.equal(r.notes, '- add updater\n- fix mic');
  assert.deepEqual(r.assets, [{ name: 'a.zip', size: 10, url: 'https://x/a.zip' }]);
  assert.equal(notesFromBody('download the installer for your computer:\n- mac'), '');
  assert.throws(() => parseRelease({ tag_name: 'latest-build' }), /no version/);
});

test('macSwapScript quotes paths and restores on failure', () => {
  const s = macSwapScript(123, "/tmp/u/Clickity.app", "/Users/o'neil/Apps/Clickity.app", '/tmp/l.log');
  assert.match(s, /kill -0 123/);
  assert.match(s, /'\/Users\/o'\\''neil\/Apps\/Clickity\.app'/);
  assert.match(s, /ditto '\/tmp\/u\/Clickity\.app'/);
  assert.match(s, /xattr -dr com\.apple\.quarantine/);
  assert.match(s, /mv '.*\.old-update' '.*Clickity\.app'/);
});

/* end to end against a fake github: release json → download with progress → AppImage swap → relaunch */
test('download + AppImage swap + relaunch (local server)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clickity-upd-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const marker = path.join(dir, 'launched.txt');
  const newImage = `#!/bin/sh\necho "new $@" > '${marker}'\n` + '#'.repeat(200_000) + '\n';
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (req.url === '/repos/x/releases/latest') {
      assert.equal(req.headers['user-agent'], 'clickity-updater');
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          tag_name: 'v1.0.7',
          body: 'changes\n- shiny',
          assets: [
            { name: 'Clickity-linux-x86_64.AppImage', size: Buffer.byteLength(newImage), browser_download_url: `${base}/dl/app` },
            { name: 'build.json', size: 10, browser_download_url: `${base}/dl/build.json` },
          ],
        }),
      );
    } else if (req.url === '/dl/build.json') {
      res.end(JSON.stringify({ version: '1.0.7', notes: 'add updater\nfix mic' }));
    } else if (req.url === '/dl/app') {
      res.setHeader('content-length', Buffer.byteLength(newImage));
      res.write(newImage.slice(0, 100_000));
      setTimeout(() => res.end(newImage.slice(100_000)), 20);
    } else if (req.url === '/limited/releases/latest') {
      res.statusCode = 403;
      res.setHeader('x-ratelimit-remaining', '0');
      res.end('{}');
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const info = await fetchLatestRelease(`${base}/repos/x`);
  assert.equal(info.version, '1.0.7');
  assert.equal(info.notes, 'add updater\nfix mic');
  await assert.rejects(fetchLatestRelease(`${base}/limited`), /rate limiting/);
  await assert.rejects(fetchLatestRelease(`${base}/nope`), /no releases yet/);
  const closed = http.createServer();
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
  const closedPort = (closed.address() as AddressInfo).port;
  await new Promise((r) => closed.close(r));
  await assert.rejects(fetchLatestRelease(`http://127.0.0.1:${closedPort}`), /offline/);

  const asset = pickAsset(info.assets, 'linux', 'x64', '/x.AppImage')!;
  const progress: number[] = [];
  const file = await downloadAsset(asset, path.join(dir, 'dl', asset.name), (f) => progress.push(f));
  assert.equal(fs.readFileSync(file, 'utf8'), newImage);
  assert.ok(progress.length > 2 && progress.at(-1) === 1, `progress ${progress}`);
  await assert.rejects(downloadAsset({ ...asset, size: asset.size + 5 }, path.join(dir, 'dl2', 'x')), /incomplete/);
  assert.ok(!fs.existsSync(path.join(dir, 'dl2', 'x.part')));

  const appImage = path.join(dir, 'apps', 'Clickity.AppImage');
  fs.mkdirSync(path.dirname(appImage));
  fs.writeFileSync(appImage, '#!/bin/sh\necho old\n', { mode: 0o755 });
  swapAppImage(file, appImage);
  assert.equal(fs.readFileSync(appImage, 'utf8'), newImage);
  assert.ok(fs.statSync(appImage).mode & 0o100);

  // relaunch waits for the "old app" to exit
  const { spawn } = await import('node:child_process');
  const old = spawn('sleep', ['0.6']);
  relaunchAfterExit(old.pid!, appImage, ['--hidden']);
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(!fs.existsSync(marker), 'launched before the old app exited');
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'new --hidden');
});
