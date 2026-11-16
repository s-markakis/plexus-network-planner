// Generates the desktop-app icons into electron/resources/ from the vector
// master, electron/resources/icon.svg (stacked floor plans with a signal on the
// top one, on a dark macOS-style tile):
//   icon.png  (1024²)  — Linux + electron-builder source
//   icon.icns          — macOS
//   icon.ico  (256²…)  — Windows
//
// The SVG is rasterised with the Chromium that Playwright already installs for
// the tests, so there is no extra dependency. .icns is derived with
// `sips`/`iconutil`, so run this on a Mac and commit the results — CI just
// consumes them.
//
//   node scripts/make-icons.mjs

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'electron', 'resources');
mkdirSync(OUT, { recursive: true });

const svg = readFileSync(join(OUT, 'icon.svg'), 'utf8');
const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16];

// One PNG per size, each rendered from the vector at its own size (sharper
// than scaling the 1024 master down), on a transparent background.
const browser = await chromium.launch();
async function png(size) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  return buf;
}

const masterPath = join(OUT, 'icon.png');
writeFileSync(masterPath, await png(1024));
console.log('✓ icon.png (1024)');

// ── .ico: a PNG-compressed entry per size ────────────────────────────
{
  const pngs = [];
  for (const s of ICO_SIZES) pngs.push(await png(s));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(ICO_SIZES.length, 4);
  let offset = 6 + 16 * ICO_SIZES.length;
  const entries = ICO_SIZES.map((s, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(s >= 256 ? 0 : s, 0);          // width  (0 = 256)
    e.writeUInt8(s >= 256 ? 0 : s, 1);          // height (0 = 256)
    e.writeUInt8(0, 2); e.writeUInt8(0, 3);     // palette, reserved
    e.writeUInt16LE(1, 4);                      // colour planes
    e.writeUInt16LE(32, 6);                     // bits per pixel
    e.writeUInt32LE(pngs[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
    return e;
  });
  writeFileSync(join(OUT, 'icon.ico'), Buffer.concat([header, ...entries, ...pngs]));
  console.log(`✓ icon.ico (${ICO_SIZES.join('/')})`);
}
await browser.close();

// ── .icns via sips + iconutil (macOS only) ───────────────────────────
if (process.platform === 'darwin') {
  const iconset = join(OUT, 'icon.iconset');
  rmSync(iconset, { recursive: true, force: true });
  mkdirSync(iconset, { recursive: true });
  for (const base of [16, 32, 128, 256, 512]) {
    for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
      const px = base * scale;
      spawnSync('sips', ['-z', String(px), String(px), masterPath, '--out', join(iconset, `icon_${base}x${base}${suffix}.png`)], { stdio: 'ignore' });
    }
  }
  const icns = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', join(OUT, 'icon.icns')], { stdio: 'inherit' });
  rmSync(iconset, { recursive: true, force: true });
  console.log(icns.status === 0 ? '✓ icon.icns' : '✗ icon.icns (iconutil failed)');
} else {
  console.log('· icon.icns skipped (needs macOS: sips + iconutil)');
}
