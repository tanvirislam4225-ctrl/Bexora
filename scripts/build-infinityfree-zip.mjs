import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

const distDir = path.resolve('dist');
if (!fs.existsSync(distDir)) {
  console.error('Error: dist/ directory does not exist. Run `npm run build` first.');
  process.exit(1);
}

const deploymentReadme = `# BEXORA — InfinityFree Production Deployment Guide

## 1. What Is Inside This Package (\`BEXORA_INFINITYFREE_PRODUCTION.zip\`)
This archive contains the compiled, production-ready static frontend build of **BEXORA** (from \`dist/\`), pre-wired to your provisioned Firebase project (\`responsive-dragon-tmn89\`), along with:
- \`index.html\` and hashed JS/CSS bundles in \`assets/\`
- \`manifest.webmanifest\`, \`sw.js\`, and Workbox precache bundle
- Official BEXORA PWA icons (\`favicon.ico\`, \`favicon-16x16.png\`, \`favicon-32x32.png\`, \`apple-touch-icon.png\`, \`icon-192.png\`, \`icon-512.png\`, \`icon-maskable-512.png\`, \`icon.svg\`, \`bexora-logo.svg\`)
- \`.htaccess\` configured for InfinityFree Apache single-page-application (SPA) routing and \`manifest.webmanifest\` MIME types
- \`.env.example\` (placeholder reference only — zero private keys or secrets are included)

## 2. Step-by-Step Upload Instructions for InfinityFree
1. Log in to your **InfinityFree Client Area** and open **Control Panel (VistaPanel)** or connect via **FileZilla FTP** (recommended for reliable multi-file uploads).
2. Navigate into your domain's web root folder: **\`htdocs/\`** (or \`yourdomain.com/htdocs/\` for addon domains).
3. Remove InfinityFree's default \`index2.html\` or placeholder \`index.html\` inside \`htdocs/\`.
4. Extract \`BEXORA_INFINITYFREE_PRODUCTION.zip\` on your computer and upload **all contents inside the \`htdocs_upload/\` folder** directly into \`htdocs/\` (so \`index.html\` and \`.htaccess\` sit directly at \`htdocs/index.html\` and \`htdocs/.htaccess\`).
5. In the **Firebase Console** (\`https://console.firebase.google.com/project/responsive-dragon-tmn89/authentication/settings\`):
   - Under **Authentication -> Sign-in method**, ensure **Google**, **Email/Password**, and (optionally) **Phone** providers are enabled.
   - Under **Authentication -> Settings -> Authorized domains**, click **Add domain** and add your InfinityFree domain (e.g. \`bexora.infinityfreeapp.com\` or your custom domain) so Firebase Authentication popups, email verification links, and password resets work on your live domain.
6. Ensure **SSL/HTTPS** is active on your InfinityFree domain (via InfinityFree's **Free SSL Certificates** tab) so Chrome PWA installation (\`beforeinstallprompt\` & Service Worker) is enabled.

## 3. Hosting Architecture & Optional External Backend Checklist
InfinityFree shared hosting serves static HTML/JS/CSS/PHP and **cannot run a persistent Node.js / Express server (\`server.ts\`)**.
- **Works Immediately on InfinityFree (100% Client -> Firebase + Security Rules)**:
  - Google Sign-In, Email/Password Registration & Login, Email Verification, Password Reset, Phone Verification
  - Public & Owner Profiles, Global Username Uniqueness, NID Front & Back Verification Uploads
  - Marketplace Browsing, Category-Specific Filters, Role-Based Bidding, Messenger Pre-Deal Chat, Escrow Deal Rooms & Immutable Deadlines
  - Manual Wallet Deposits (bKash, Nagad, Rocket configured via Admin Panel -> Payment & Fee Settings), Withdrawals, Reviews, Support Contacts, and PWA Installation
- **Requires Optional Separate Node.js / Cloud Run Backend (\`server.ts\`)**:
  - Server-side Gemini AI Screenshot OCR (\`/api/ai/verify-evidence\`) and live AI Developer Chat (\`/api/ai/developer-chat\`). On static InfinityFree hosting without an external Node backend, BEXORA automatically falls back to **Manual Administrator Evidence Review** and deterministic system diagnostics without errors.
`;

function addDirToZip(zipFolder, dirPath, relPrefix = '') {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.endsWith('.zip')) continue;
    const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (relPath === 'assets/aistudio') continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      addDirToZip(zipFolder.folder(entry.name), fullPath, relPath);
    } else {
      zipFolder.file(entry.name, fs.readFileSync(fullPath));
    }
  }
}

const zip = new JSZip();
const uploadFolder = zip.folder('htdocs_upload');
addDirToZip(uploadFolder, distDir);
zip.file('INFINITYFREE_DEPLOYMENT_README.md', deploymentReadme);
if (fs.existsSync('.env.example')) {
  zip.file('.env.example', fs.readFileSync('.env.example'));
}

const buf = await zip.generateAsync({
  type: 'nodebuffer',
  compression: 'DEFLATE',
  compressionOptions: { level: 9 },
});

const rootZipPath = path.resolve('BEXORA_INFINITYFREE_PRODUCTION.zip');
const publicZipPath = path.resolve('public', 'BEXORA_INFINITYFREE_PRODUCTION.zip');
const distZipPath = path.resolve('dist', 'BEXORA_INFINITYFREE_PRODUCTION.zip');

fs.writeFileSync(rootZipPath, buf);
fs.writeFileSync(publicZipPath, buf);
fs.writeFileSync(distZipPath, buf);

// Verify archive integrity by reloading with JSZip
const verifyZip = await JSZip.loadAsync(fs.readFileSync(rootZipPath));
const fileList = Object.keys(verifyZip.files);
if (!fileList.includes('htdocs_upload/index.html') || !fileList.includes('htdocs_upload/.htaccess')) {
  console.error('Archive verification failed! Missing index.html or .htaccess:', fileList);
  process.exit(1);
}

console.log(`Verified BEXORA_INFINITYFREE_PRODUCTION.zip (${(buf.length / 1024).toFixed(1)} KB, ${fileList.length} entries).`);
