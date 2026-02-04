#!/usr/bin/env node
/**
 * Generate PWA and Tauri icons from source logo
 */

import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SOURCE = join(ROOT, 'logo.png');
const CLIENT_PUBLIC = join(ROOT, 'packages/client/public');
const TAURI_ICONS = join(ROOT, 'src-tauri/icons');

// PWA icon sizes
const PWA_SIZES = [192, 512];

// Additional sizes for apple-touch-icon and favicon
const EXTRA_SIZES = [
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'favicon-32x32.png', size: 32 },
  { name: 'favicon-16x16.png', size: 16 },
];

// Tauri icon sizes (Windows, macOS, Linux)
const TAURI_SIZES = [32, 128, 256, 512];

async function generateIcons() {
  console.log('Generating icons from:', SOURCE);

  // Ensure directories exist
  if (!existsSync(CLIENT_PUBLIC)) {
    mkdirSync(CLIENT_PUBLIC, { recursive: true });
  }
  if (!existsSync(TAURI_ICONS)) {
    mkdirSync(TAURI_ICONS, { recursive: true });
  }

  const image = sharp(SOURCE);

  // Generate PWA icons
  for (const size of PWA_SIZES) {
    const output = join(CLIENT_PUBLIC, `pwa-${size}x${size}.png`);
    await image
      .clone()
      .resize(size, size, { fit: 'contain', background: { r: 28, g: 30, b: 38, alpha: 1 } })
      .png()
      .toFile(output);
    console.log(`  Created: pwa-${size}x${size}.png`);
  }

  // Generate extra icons (apple-touch, favicons)
  for (const { name, size } of EXTRA_SIZES) {
    const output = join(CLIENT_PUBLIC, name);
    await image
      .clone()
      .resize(size, size, { fit: 'contain', background: { r: 28, g: 30, b: 38, alpha: 1 } })
      .png()
      .toFile(output);
    console.log(`  Created: ${name}`);
  }

  // Generate ICO favicon (proper ICO format with multiple sizes)
  const faviconOutput = join(CLIENT_PUBLIC, 'favicon.ico');
  const ico16 = await image.clone().resize(16, 16, { fit: 'contain', background: { r: 28, g: 30, b: 38, alpha: 1 } }).png().toBuffer();
  const ico32 = await image.clone().resize(32, 32, { fit: 'contain', background: { r: 28, g: 30, b: 38, alpha: 1 } }).png().toBuffer();
  const ico48 = await image.clone().resize(48, 48, { fit: 'contain', background: { r: 28, g: 30, b: 38, alpha: 1 } }).png().toBuffer();
  const faviconIco = await pngToIco([ico16, ico32, ico48]);
  writeFileSync(faviconOutput, faviconIco);
  console.log(`  Created: favicon.ico (proper ICO format)`);

  // Generate Tauri icons
  for (const size of TAURI_SIZES) {
    const output = join(TAURI_ICONS, `${size}x${size}.png`);
    await image
      .clone()
      .resize(size, size, { fit: 'contain', background: { r: 28, g: 30, b: 38, alpha: 1 } })
      .png()
      .toFile(output);
    console.log(`  Created: tauri ${size}x${size}.png`);
  }

  // Tauri also needs icon.png (512) and icon.ico
  await image
    .clone()
    .resize(512, 512, { fit: 'contain', background: { r: 28, g: 30, b: 38, alpha: 1 } })
    .png()
    .toFile(join(TAURI_ICONS, 'icon.png'));
  console.log(`  Created: tauri icon.png`);

  // For icon.ico, use proper ICO format with multiple sizes (Windows needs this)
  const tauriIco16 = await image.clone().resize(16, 16, { fit: 'contain', background: { r: 28, g: 30, b: 38, alpha: 1 } }).png().toBuffer();
  const tauriIco32 = await image.clone().resize(32, 32, { fit: 'contain', background: { r: 28, g: 30, b: 38, alpha: 1 } }).png().toBuffer();
  const tauriIco48 = await image.clone().resize(48, 48, { fit: 'contain', background: { r: 28, g: 30, b: 38, alpha: 1 } }).png().toBuffer();
  const tauriIco64 = await image.clone().resize(64, 64, { fit: 'contain', background: { r: 28, g: 30, b: 38, alpha: 1 } }).png().toBuffer();
  const tauriIco128 = await image.clone().resize(128, 128, { fit: 'contain', background: { r: 28, g: 30, b: 38, alpha: 1 } }).png().toBuffer();
  const tauriIco256 = await image.clone().resize(256, 256, { fit: 'contain', background: { r: 28, g: 30, b: 38, alpha: 1 } }).png().toBuffer();
  const tauriIcoData = await pngToIco([tauriIco16, tauriIco32, tauriIco48, tauriIco64, tauriIco128, tauriIco256]);
  writeFileSync(join(TAURI_ICONS, 'icon.ico'), tauriIcoData);
  console.log(`  Created: tauri icon.ico (proper ICO format)`);

  console.log('\nDone! Icons generated successfully.');
}

generateIcons().catch(console.error);
