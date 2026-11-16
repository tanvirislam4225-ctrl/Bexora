# BEXORA Deployment & Hosting Guide

BEXORA is a full-stack marketplace built with **React + Vite + TypeScript + Tailwind CSS** on the frontend and **Node.js + Express (`server.ts` -> `server.js`) + Firebase (Auth, Firestore, Realtime Database, Storage, FCM)** on the backend.

## Architecture & Security Separation

| Component | Where It Runs | Notes |
| --- | --- | --- |
| **Static Frontend (`dist/`)** | Any static CDN or Express static middleware | Contains React UI + public Firebase config (`firebase-applet-config.json` & `VITE_*`). **Never** place API keys, payment secrets, or service accounts in `VITE_*`. |
| **Trusted Express Backend (`server.js`)** | Node.js 20+ server (Cloud Run, Hostinger Node.js, Render, Railway, VPS) | Handles payment verification, wallet ledger mutations, escrow release, server-side admin role verification, complete paged financial aggregations, FCM push delivery, and Gemini AI audits. |
| **Firebase Services** | Google Firebase Cloud | Authentication, Firestore (with `firestore.rules`), Realtime Database (`database.rules.json`), Storage (`storage.rules`), and FCM. |

> **Important:** A static-only host (such as Netlify static hosting, Hostinger Shared Static, or InfinityFree) **cannot** execute Express server code (`server.js`). On static-only hosts, deploy `dist/` to the static host and host `server.js` separately on a Node.js-capable platform, passing `VITE_API_BASE_URL` at frontend build time and `ALLOWED_ORIGINS` on the backend.

---

## Environment Variables

Copy `.env.example` to `.env` for local or server-side setup. **Never commit `.env` or `FIREBASE_SERVICE_ACCOUNT_JSON` to GitHub.**

### Public Build-Time Frontend Variables (`VITE_*`)
- `VITE_API_BASE_URL` *(optional)*: Origin of your separately hosted Express backend when frontend & backend are on different domains (e.g., `https://api.yourdomain.com`). Leave unset when `server.js` serves both the frontend and `/api/*` from the same origin.
- `VITE_BASE_PATH` *(optional, defaults to `/`)*: Base public URL path for Vite.
- `VITE_FIREBASE_VAPID_KEY` *(optional)*: Public Web Push VAPID key override.
- `VITE_FIREBASE_CUSTOM_AUTH_DOMAIN` *(optional)*: Verified custom HTTPS auth domain override.

### Private Server-Only Variables (Backend Host Only)
- `PORT` (defaults to `3000`)
- `NODE_ENV=production`
- `ALLOWED_ORIGINS`: Comma-separated list of allowed browser origins for cross-origin `/api/*` CORS & CSRF verification (required if frontend is on a separate domain or behind a reverse proxy rewriting `Host`, e.g., `https://bexora.netlify.app,https://yourdomain.com`).
- `TRUST_PROXY_HOPS`: Reverse proxy hops in front of Express (typically `1` on Cloud Run / Hostinger / Render, or `2` behind Cloudflare + Hostinger).
- `FIREBASE_SERVICE_ACCOUNT_JSON`: Optional minified JSON string of a Firebase Admin service account (auto-handled on Google Cloud Run via Application Default Credentials; required on external hosts like Hostinger/Render for full Admin SDK access).
- `GEMINI_API_KEY`, `SECUREPAY_API_KEY`, `WORDPRESS_*`, `BKASH_PAYMENT_NUMBER`, `NAGAD_PAYMENT_NUMBER`, `ROCKET_PAYMENT_NUMBER`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`.

---

## Option 1: Full-Stack Node.js Hosting (Hostinger Node.js / Cloud Run / Render / Railway)

Serves both `dist/` and `/api/*` from a single Node.js process (`server.js`).

1. **Install dependencies:** `npm ci`
2. **Build static frontend + bundled Node server:** `npm run build`
   - Outputs static assets to `dist/` and bundled ESM server to `server.js`.
3. **Start server:** `npm start` (`node server.js`)
4. **Health check endpoint:** `GET /api/health` -> `{"status":"ok"}`
5. **Hostinger Node.js specifics:**
   - Set **Entry file** to `server.js`.
   - Set **Build command** to `npm run build` and **Start command** to `npm start`.
   - Configure `FIREBASE_SERVICE_ACCOUNT_JSON`, `TRUST_PROXY_HOPS=1`, and `ALLOWED_ORIGINS=https://yourdomain.com,https://www.yourdomain.com`.

---

## Option 2: Netlify (GitHub-Connected Static Frontend + External Node Backend)

`netlify.toml` is preconfigured for GitHub-connected deployments:
- **Build command:** `npm run build:web`
- **Publish directory:** `dist`
- **SPA routing:** `/* -> /index.html` (HTTP 200)

Steps:
1. Deploy `server.js` on a Node.js host (Cloud Run, Render, Railway, or Hostinger Node.js).
2. In Netlify Site Settings -> Environment Variables, set `VITE_API_BASE_URL` to your backend URL (e.g., `https://bexora-api.onrender.com`).
3. On your backend host, add your Netlify domain to `ALLOWED_ORIGINS`.
4. In Firebase Console -> Authentication -> Settings -> Authorized Domains, add your Netlify domain.

---

## Option 3: InfinityFree (Static Frontend Only + External Node Backend)

**Official Technical Assessment:**
- InfinityFree provides **Apache static file hosting + PHP + MySQL** only.
- InfinityFree **does not** support Node.js runtimes, persistent processes, Express servers (`server.js`), or `firebase-admin`.
- Because BEXORA's payments, wallet ledger, escrow settlement, admin authorization, and complete Firestore financial aggregations require trusted server execution, **the Express backend cannot run on InfinityFree**.

**Compatible Split-Deployment for InfinityFree:**
1. Host the Express backend (`server.js`) on a Node.js-capable host (Cloud Run, Render, Hostinger Node.js, etc.).
2. Build the static frontend locally or in GitHub Actions with `VITE_API_BASE_URL` pointing to your backend:
   ```bash
   VITE_API_BASE_URL="https://api.yourdomain.com" npm run build:web
   ```
3. Upload the entire contents of `dist/` (including `.htaccess` copied from `public/.htaccess` for Apache SPA fallback and `.webmanifest`/`.wav` MIME types) into InfinityFree's `htdocs/` folder.
4. Add your InfinityFree domain to `ALLOWED_ORIGINS` on the backend and to **Authorized Domains** in Firebase Authentication.

---

## Pre-Deployment Firebase Checklist

- Deploy Firestore rules (`firestore.rules`), Storage rules (`storage.rules`), and Realtime Database rules (`database.rules.json`).
- Verify your custom deployment domain is added to **Firebase Console -> Authentication -> Settings -> Authorized Domains**.
- Never commit `.env` or service account keys to GitHub (both are ignored in `.gitignore`).
