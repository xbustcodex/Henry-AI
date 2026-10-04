// Notarization hook — runs after signing, macOS only.
//
// Required environment (names only; no value ever lives in this repo):
//   APPLE_ID           — Apple account used for the notarization submission
//   APPLE_APP_PASSWORD — app-specific password for that account
//   APPLE_TEAM_ID      — the Apple Team ID that OWNS Henry's signing identity
//
// There is deliberately NO default team. An earlier revision fell back to the
// previous owner's Apple Developer team ID, so any build machine holding that
// team's certificate notarized Henry under a team Henry does not control.
// Every variable below is now mandatory; a build without them ships unsigned
// rather than misattributed.

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_PASSWORD || !APPLE_TEAM_ID) {
    console.warn(
      '[notarize] SKIPPED — notarization needs APPLE_ID, APPLE_APP_PASSWORD and ' +
      'APPLE_TEAM_ID. This build ships UNSIGNED and UNNOTARIZED. Henry has no signing ' +
      'infrastructure configured; supplying your own team is the only supported path.'
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`Notarizing ${appPath}...`);

  await notarize({
    tool: 'notarytool',
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });

  console.log('Notarization complete');
};