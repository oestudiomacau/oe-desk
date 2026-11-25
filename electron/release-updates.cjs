const repository = 'oestudiomacau/oe-desk';
const releaseRoot = `https://github.com/${repository}/releases`;
const latestReleaseApi = `https://api.github.com/repos/${repository}/releases/latest`;
const versionPattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function compareVersions(left, right) {
  const a = versionPattern.exec(left);
  const b = versionPattern.exec(right);
  if (!a || !b) return null;
  for (let part = 1; part <= 3; part += 1) {
    const diff = Number(a[part]) - Number(b[part]);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

function selectUpdate(release, currentVersion, platform, arch) {
  const latestTag = typeof release?.tag_name === 'string' ? release.tag_name : '';
  const comparison = compareVersions(latestTag, currentVersion);
  if (release?.draft || release?.prerelease || comparison === null) return { status: 'unpublished', currentVersion };
  const latestVersion = latestTag.replace(/^v/, '');
  if (comparison <= 0) return { status: 'current', currentVersion, latestVersion };
  const filename = platform === 'win32' && arch === 'x64' ? `OE-DESK-Setup-${latestVersion}.exe`
    : platform === 'darwin' && ['arm64', 'x64'].includes(arch) ? `OE-DESK-${latestVersion}-macOS-${arch}.zip` : '';
  const url = `${releaseRoot}/download/${latestTag}/${filename}`;
  const asset = Array.isArray(release.assets) && release.assets.find(item =>
    filename && item?.name === filename && item.browser_download_url === url && item.state === 'uploaded');
  if (!asset) return { status: 'unavailable', currentVersion, latestVersion };
  return { status: 'available', currentVersion, latestVersion, platform, filename, downloadUrl: url,
    releaseUrl: `${releaseRoot}/tag/${latestTag}` };
}

function createUpdateChecker({ currentVersion, packaged, platform, arch, request = fetch }) {
  let cached;
  let inFlight;
  async function readLatest() {
    try {
      const response = await request(latestReleaseApi, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `OE-DESK/${currentVersion}` },
        signal: AbortSignal.timeout(8000),
        redirect: 'error'
      });
      if (response.status === 404) return { status: 'unpublished', currentVersion };
      if (!response.ok) return { status: 'failed', currentVersion };
      return selectUpdate(await response.json(), currentVersion, platform, arch);
    } catch {
      return { status: 'failed', currentVersion };
    }
  }
  return function check(force = false) {
    if (!packaged) return Promise.resolve({ status: 'development', currentVersion });
    if (inFlight) return inFlight;
    if (!force && cached && Date.now() - cached.time < 30 * 60 * 1000) return Promise.resolve(cached.result);
    inFlight = readLatest().then(result => {
      cached = { result, time: Date.now() };
      return result;
    }).finally(() => { inFlight = null; });
    return inFlight;
  };
}

module.exports = { selectUpdate, createUpdateChecker };
