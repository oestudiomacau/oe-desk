const assert = require('node:assert/strict');
const test = require('node:test');
const { createUpdateChecker, selectUpdate } = require('../electron/release-updates.cjs');

const root = 'https://github.com/oestudiomacau/oe-desk/releases';
const tag = 'v0.1.10';
const release = {
  tag_name: tag,
  assets: ['OE-DESK-Setup-0.1.10.exe', 'OE-DESK-0.1.10-macOS-arm64.zip',
    'OE-DESK-Private-0.1.10-macOS-x64.zip'].map(name => ({
    name, state: 'uploaded', browser_download_url: `${root}/download/${tag}/${name}`
  }))
};

test('installed OE DESK selects the public asset for its OS and newer numeric version', () => {
  const windows = selectUpdate(release, '0.1.9', 'win32', 'x64');
  const mac = selectUpdate(release, '0.1.9', 'darwin', 'arm64');
  assert.equal(windows.downloadUrl, `${root}/download/${tag}/OE-DESK-Setup-0.1.10.exe`);
  assert.equal(mac.filename, 'OE-DESK-0.1.10-macOS-arm64.zip');
  assert.equal(selectUpdate(release, '0.1.9', 'darwin', 'x64').status, 'unavailable');
  assert.equal(selectUpdate(release, '0.1.10', 'win32', 'x64').status, 'current');
  assert.equal(selectUpdate(release, '0.2.0', 'win32', 'x64').status, 'current');
  assert.equal(selectUpdate({ ...release, prerelease: true }, '0.1.9', 'win32', 'x64').status, 'unpublished');
  assert.equal(selectUpdate({ ...release, assets: [{ ...release.assets[0], browser_download_url: 'https://example.com/file.exe' }] },
    '0.1.9', 'win32', 'x64').status, 'unavailable');
});

test('startup checks share a public release request and manual checks refresh it', async () => {
  let requests = 0;
  const check = createUpdateChecker({ currentVersion: '0.1.9', packaged: true, platform: 'win32', arch: 'x64',
    request: async url => {
      requests += 1;
      assert.equal(url, 'https://api.github.com/repos/oestudiomacau/oe-desk/releases/latest');
      return { status: 200, ok: true, json: async () => release };
    }
  });
  const [first, second] = await Promise.all([check(), check()]);
  assert.equal(first.status, 'available');
  assert.equal(second, first);
  assert.equal(requests, 1);
  await check();
  assert.equal(requests, 1);
  await check(true);
  assert.equal(requests, 2);
});
