const { cp, rm } = require('node:fs/promises');
const { resolve, join } = require('node:path');

const runtime = resolve('.desktop-runtime-win-x64');

module.exports = {
  appId: 'design.dreamatic.desktop',
  productName: 'DreamaticArt',
  directories: { app: 'apps/desktop', output: 'release' },
  files: ['main.mjs', 'lifecycle.mjs', 'preload.cjs', 'package.json'],
  asar: true,
  electronDist: resolve('node_modules/electron/dist'),
  extraResources: [{
    from: runtime,
    to: 'runtime',
    filter: ['**/*', '!node_modules/**', '!.downloads/**', '!Dreamatic.ico'],
  }],
  win: {
    icon: join(runtime, 'Dreamatic.ico'),
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'DreamaticArt',
    uninstallDisplayName: 'DreamaticArt',
    deleteAppDataOnUninstall: false,
  },
  artifactName: '${productName}-${version}-windows-${arch}-setup.${ext}',
  npmRebuild: false,
  afterPack: async context => {
    // Workspace packages are Windows junctions. Dereference them so the
    // installed application never points back to the build checkout.
    const destination = join(context.appOutDir, 'resources/runtime/node_modules');
    await rm(destination, { recursive: true, force: true });
    await cp(join(runtime, 'node_modules'), destination, { recursive: true, dereference: true });
  },
};
