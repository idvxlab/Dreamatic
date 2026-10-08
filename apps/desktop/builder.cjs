const { execFileSync } = require('node:child_process');
const { resolve, join } = require('node:path');
module.exports = {
  appId: 'design.dreamatic.desktop', productName: 'DreamaticArt',
  directories: { app: 'apps/desktop', output: 'release' },
  files: ['main.mjs', 'lifecycle.mjs', 'preload.cjs', 'package.json'],
  asar: true,
  electronDist: 'node_modules/electron/dist',
  extraResources: [{ from: '.desktop-runtime', to: 'runtime', filter: ['**/*', '!.downloads/**', '!**/.DS_Store'] }],
  mac: { icon: '.desktop-runtime/Dreamatic.icns', target: [{ target: 'dmg', arch: ['arm64'] }], category: 'public.app-category.graphics-design', hardenedRuntime: true, identity: process.env.CSC_NAME || '-' },
  dmg: { title: 'DreamaticArt', contents: [{ x: 150, y: 180 }, { x: 450, y: 180, type: 'link', path: '/Applications' }] },
  artifactName: '${productName}-${version}-mac-${arch}.${ext}',
  npmRebuild: false,
  afterPack: async (context) => {
    // extraResources excludes node_modules by default. Explicitly copy the locked runtime
    // dependency tree before signing; preserve npm workspace links and nested packages.
    execFileSync('/usr/bin/ditto', [resolve('.desktop-runtime/node_modules'), join(context.appOutDir, 'DreamaticArt.app/Contents/Resources/runtime/node_modules')]);
  },
};
