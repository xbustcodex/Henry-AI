// Notarization script — runs after signing
// Requires env vars: APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID
const { notarize } = require('@electron/notarize');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  if (!process.env.APPLE_ID || !process.env.APPLE_APP_PASSWORD) {
    console.log('Skipping notarization — APPLE_ID or APPLE_APP_PASSWORD not set');
    return;
  }

  console.log(`Notarizing ${appPath}...`);
  
  await notarize({
    tool: 'notarytool',
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID || 'NFS22LSQRC',
  });

  console.log('Notarization complete');
};
