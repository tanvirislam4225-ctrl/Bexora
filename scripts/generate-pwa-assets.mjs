import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const publicDir = path.resolve('public');
fs.mkdirSync(publicDir, { recursive: true });

// CRC32 table for valid PNG chunks
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/**
 * Renders the crisp official BEXORA emblem (dark navy #0B1020 field, vibrant orange #FF6500 & gold #FFD400 geometric 'B' shield mark)
 * at any square size, with optional maskable safe-zone padding.
 */
function renderBexoraPng(size, maskable = false) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const padRatio = maskable ? 0.18 : 0.08;
  const minBound = size * padRatio;
  const maxBound = size * (1 - padRatio);
  const boxSize = maxBound - minBound;
  const cornerR = boxSize * 0.22;

  for (let y = 0; y < size; y++) {
    const rowOffset = y * (size * 4 + 1);
    raw[rowOffset] = 0; // filter type 0

    for (let x = 0; x < size; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      // Base dark navy background (#0B1020)
      let r = 11, g = 16, b = 32, a = 255;

      // Check rounded inner emblem badge
      const inX = x >= minBound && x <= maxBound;
      const inY = y >= minBound && y <= maxBound;
      let insideBadge = false;
      if (inX && inY) {
        const dx = Math.max(minBound + cornerR - x, 0, x - (maxBound - cornerR));
        const dy = Math.max(minBound + cornerR - y, 0, y - (maxBound - cornerR));
        insideBadge = (dx * dx + dy * dy) <= cornerR * cornerR;
      }

      if (insideBadge) {
        // Subtle gradient from #FF6500 (top-left) to #FF851B / #FFD400 accent
        const t = ((x - minBound) + (y - minBound)) / (2 * boxSize);
        r = Math.round(255);
        g = Math.round(101 + t * 55);
        b = Math.round(0 + t * 18);

        // Draw crisp geometric "B" letterform in white (#FFFFFF) with gold spark
        const nx = (x - minBound) / boxSize;
        const ny = (y - minBound) / boxSize;

        const leftStem = nx >= 0.28 && nx <= 0.41 && ny >= 0.22 && ny <= 0.78;
        const topBar = nx >= 0.28 && nx <= 0.63 && ny >= 0.22 && ny <= 0.33;
        const midBar = nx >= 0.28 && nx <= 0.65 && ny >= 0.45 && ny <= 0.55;
        const botBar = nx >= 0.28 && nx <= 0.66 && ny >= 0.67 && ny <= 0.78;

        // Upper bowl right arc
        const ucx = 0.59, ucy = 0.385, urOuter = 0.165, urInner = 0.058;
        const uDist = Math.hypot(nx - ucx, ny - ucy);
        const upperBowl = nx >= 0.54 && uDist <= urOuter && uDist >= urInner && ny >= 0.22 && ny <= 0.55;

        // Lower bowl right arc
        const lcx = 0.61, lcy = 0.615, lrOuter = 0.175, lrInner = 0.062;
        const lDist = Math.hypot(nx - lcx, ny - lcy);
        const lowerBowl = nx >= 0.55 && lDist <= lrOuter && lDist >= lrInner && ny >= 0.45 && ny <= 0.78;

        if (leftStem || topBar || midBar || botBar || upperBowl || lowerBowl) {
          r = 255; g = 255; b = 255;
        }

        // Gold verification dot in top-right of badge
        const dotDist = Math.hypot(nx - 0.78, ny - 0.24);
        if (dotDist <= 0.055) {
          r = 255; g = 212; b = 0;
        }
      }

      raw[pxOffset] = r;
      raw[pxOffset + 1] = g;
      raw[pxOffset + 2] = b;
      raw[pxOffset + 3] = a;
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildIcoFromPng(png32Buf) {
  // Valid ICO header wrapping a 32x32 PNG payload
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // ICO type
  header.writeUInt16LE(1, 4); // 1 image

  const dir = Buffer.alloc(16);
  dir[0] = 32; // width
  dir[1] = 32; // height
  dir[2] = 0;  // palette
  dir[3] = 0;  // reserved
  dir.writeUInt16LE(1, 4);  // color planes
  dir.writeUInt16LE(32, 6); // bpp
  dir.writeUInt32LE(png32Buf.length, 8);
  dir.writeUInt32LE(22, 12); // offset = 6 + 16

  return Buffer.concat([header, dir, png32Buf]);
}

const png16 = renderBexoraPng(16, false);
const png32 = renderBexoraPng(32, false);
const png180 = renderBexoraPng(180, false);
const png192 = renderBexoraPng(192, false);
const png512 = renderBexoraPng(512, false);
const pngMaskable512 = renderBexoraPng(512, true);
const icoBuf = buildIcoFromPng(png32);

fs.writeFileSync(path.join(publicDir, 'favicon-16x16.png'), png16);
fs.writeFileSync(path.join(publicDir, 'favicon-32x32.png'), png32);
fs.writeFileSync(path.join(publicDir, 'favicon.ico'), icoBuf);
fs.writeFileSync(path.join(publicDir, 'apple-touch-icon.png'), png180);
fs.writeFileSync(path.join(publicDir, 'icon-192.png'), png192);
fs.writeFileSync(path.join(publicDir, 'icon-512.png'), png512);
fs.writeFileSync(path.join(publicDir, 'icon-maskable-512.png'), pngMaskable512);

// Official SVG Square Icon & Horizontal Brand Logo
const iconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
  <rect width="128" height="128" rx="28" fill="#0B1020"/>
  <rect x="12" y="12" width="104" height="104" rx="22" fill="url(#bxGrad)" stroke="#191919" stroke-width="4"/>
  <path d="M40 34H69C79.5 34 86 40 86 48.5C86 54.6 82.4 59.1 76.8 60.9C83.8 62.7 88 68 88 75.5C88 85.4 80.5 94 68.5 94H40V34ZM54 45V56.5H66.5C70.8 56.5 73.5 54.1 73.5 50.7C73.5 47.3 70.8 45 66.5 45H54ZM54 67V82.5H67.5C72.4 82.5 75.5 79.8 75.5 74.8C75.5 69.9 72.4 67 67.5 67H54Z" fill="#FFFFFF"/>
  <circle cx="96" cy="32" r="7" fill="#FFD400"/>
  <defs>
    <linearGradient id="bxGrad" x1="12" y1="12" x2="116" y2="116" gradientUnits="userSpaceOnUse">
      <stop stop-color="#FF6500"/>
      <stop offset="1" stop-color="#FF8C1A"/>
    </linearGradient>
  </defs>
</svg>`;

const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 380 88" fill="none">
  <rect x="4" y="8" width="72" height="72" rx="18" fill="#0B1020"/>
  <rect x="10" y="14" width="60" height="60" rx="14" fill="#FF6500"/>
  <path d="M27 26H44.5C50.8 26 54.8 29.5 54.8 34.7C54.8 38.4 52.6 41.1 49.2 42.2C53.4 43.3 56 46.5 56 51C56 57 51.4 62 44.2 62H27V26ZM35.5 32.8V39.6H43C45.6 39.6 47.2 38.2 47.2 36.2C47.2 34.1 45.6 32.8 43 32.8H35.5ZM35.5 45.8V55.2H43.6C46.6 55.2 48.5 53.6 48.5 50.5C48.5 47.5 46.6 45.8 43.6 45.8H35.5Z" fill="#FFFFFF"/>
  <circle cx="59" cy="24" r="4.5" fill="#FFD400"/>
  <text x="92" y="51" font-family="'Plus Jakarta Sans', system-ui, sans-serif" font-weight="800" font-size="36" letter-spacing="-0.03em" fill="currentColor">BEXORA</text>
  <text x="94" y="70" font-family="'Plus Jakarta Sans', system-ui, sans-serif" font-weight="700" font-size="11.5" letter-spacing="0.12em" fill="#FF6500">BUY &amp; SELL DIGITAL ASSETS</text>
</svg>`;

fs.writeFileSync(path.join(publicDir, 'icon.svg'), iconSvg);
fs.writeFileSync(path.join(publicDir, 'bexora-logo.svg'), logoSvg);

// Apache .htaccess for InfinityFree SPA routing & proper MIME types
const htaccess = `<IfModule mod_mime.c>
  AddType application/manifest+json .webmanifest
  AddType application/javascript .js .mjs
  AddType image/svg+xml .svg
  AddType image/x-icon .ico
  AddType audio/wav .wav
</IfModule>

<IfModule mod_rewrite.c>
  RewriteEngine On
  RewriteBase /

  # Do not rewrite existing files, directories, manifest, or service worker
  RewriteCond %{REQUEST_FILENAME} -f [OR]
  RewriteCond %{REQUEST_FILENAME} -d
  RewriteRule ^ - [L]

  # Route all client-side SPA paths to index.html
  RewriteRule ^ index.html [L]
</IfModule>
`;

fs.writeFileSync(path.join(publicDir, '.htaccess'), htaccess);
console.log('Generated official BEXORA PWA icons, SVG logos, and InfinityFree .htaccess successfully.');
