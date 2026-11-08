import fs from 'node:fs';
import path from 'node:path';

/**
 * Generates clean, small, valid 16-bit mono 22,050 Hz PCM .wav candidate notification sounds
 * inside `public/sounds/` ONLY if each file does not already exist.
 *
 * Preservation guarantee: Existing approved `.wav` files are NEVER overwritten during builds
 * unless `--force` is explicitly passed on the CLI.
 */
const SAMPLE_RATE = 22050;
const forceOverwrite = process.argv.includes('--force');
const soundsDir = path.resolve('public', 'sounds');
fs.mkdirSync(soundsDir, { recursive: true });

/**
 * Synthesizes a multi-note chime into a standard RIFF WAVE (PCM 16-bit mono) Buffer.
 * @param {Array<{ freq: number; startSec: number; durationSec: number; gain: number; harmonic2?: number; harmonic3?: number }>} notes
 * @param {number} totalDurationSec
 */
function synthesizeWav(notes, totalDurationSec) {
  const numSamples = Math.max(1, Math.floor(SAMPLE_RATE * totalDurationSec));
  const floatBuf = new Float64Array(numSamples);

  for (const note of notes) {
    const startIdx = Math.max(0, Math.floor(note.startSec * SAMPLE_RATE));
    const lenSamples = Math.max(1, Math.floor(note.durationSec * SAMPLE_RATE));
    const attackSamples = Math.max(1, Math.min(Math.floor(0.012 * SAMPLE_RATE), Math.floor(lenSamples * 0.2)));
    const h2 = note.harmonic2 ?? 0.22;
    const h3 = note.harmonic3 ?? 0.06;

    for (let i = 0; i < lenSamples; i++) {
      const idx = startIdx + i;
      if (idx >= numSamples) break;
      const t = i / SAMPLE_RATE;

      // Smooth raised-cosine attack + exponential bell decay + tail fade-out
      let env = 1;
      if (i < attackSamples) {
        env = 0.5 * (1 - Math.cos((Math.PI * i) / attackSamples));
      } else {
        const decayProgress = (i - attackSamples) / Math.max(1, lenSamples - attackSamples);
        env = Math.exp(-4.2 * decayProgress) * (1 - Math.pow(decayProgress, 3));
      }

      const w = 2 * Math.PI * note.freq * t;
      const sample =
        Math.sin(w) +
        h2 * Math.sin(2 * w) * Math.exp(-3.0 * (i / lenSamples)) +
        h3 * Math.sin(3 * w) * Math.exp(-5.0 * (i / lenSamples));

      floatBuf[idx] += sample * note.gain * env;
    }
  }

  // Soft limiter to guarantee zero clipping
  let peak = 0;
  for (let i = 0; i < numSamples; i++) {
    const abs = Math.abs(floatBuf[i]);
    if (abs > peak) peak = abs;
  }
  const normScale = peak > 0.92 ? 0.9 / peak : 1.0;

  const dataByteLength = numSamples * 2;
  const wav = Buffer.alloc(44 + dataByteLength);

  // RIFF chunk descriptor
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataByteLength, 4);
  wav.write('WAVE', 8, 'ascii');

  // fmt sub-chunk
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16); // Subchunk1Size (PCM)
  wav.writeUInt16LE(1, 20);  // AudioFormat = 1 (Linear PCM)
  wav.writeUInt16LE(1, 22);  // NumChannels = 1 (Mono)
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 2, 28); // ByteRate
  wav.writeUInt16LE(2, 32);  // BlockAlign
  wav.writeUInt16LE(16, 34); // BitsPerSample = 16

  // data sub-chunk
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataByteLength, 40);

  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, floatBuf[i] * normScale));
    const int16 = Math.round(clamped * 32767);
    wav.writeInt16LE(int16, 44 + i * 2);
  }

  return wav;
}

const CANDIDATE_SOUNDS = [
  {
    filename: '01_soft_normal.wav',
    label: 'Soft Normal',
    durationSec: 0.38,
    notes: [
      { freq: 523.25, startSec: 0.0, durationSec: 0.20, gain: 0.42, harmonic2: 0.16, harmonic3: 0.03 }, // C5
      { freq: 783.99, startSec: 0.09, durationSec: 0.27, gain: 0.46, harmonic2: 0.14, harmonic3: 0.02 }, // G5
    ],
  },
  {
    filename: '02_crisp_normal.wav',
    label: 'Crisp Modern',
    durationSec: 0.34,
    notes: [
      { freq: 659.25, startSec: 0.0, durationSec: 0.14, gain: 0.45, harmonic2: 0.26, harmonic3: 0.08 }, // E5
      { freq: 987.77, startSec: 0.075, durationSec: 0.24, gain: 0.50, harmonic2: 0.22, harmonic3: 0.06 }, // B5
    ],
  },
  {
    filename: '03_premium_deal.wav',
    label: 'Premium Deal Chime',
    durationSec: 0.72,
    notes: [
      { freq: 587.33, startSec: 0.0, durationSec: 0.26, gain: 0.44, harmonic2: 0.24, harmonic3: 0.07 },  // D5
      { freq: 739.99, startSec: 0.10, durationSec: 0.28, gain: 0.46, harmonic2: 0.22, harmonic3: 0.06 }, // F#5
      { freq: 880.00, startSec: 0.20, durationSec: 0.32, gain: 0.48, harmonic2: 0.20, harmonic3: 0.05 }, // A5
      { freq: 1174.66, startSec: 0.31, durationSec: 0.39, gain: 0.54, harmonic2: 0.18, harmonic3: 0.05 }, // D6
    ],
  },
  {
    filename: '04_urgent_deal.wav',
    label: 'Stronger Deal Alert',
    durationSec: 0.78,
    notes: [
      { freq: 783.99, startSec: 0.0, durationSec: 0.18, gain: 0.50, harmonic2: 0.28, harmonic3: 0.09 },  // G5
      { freq: 1046.50, startSec: 0.11, durationSec: 0.22, gain: 0.54, harmonic2: 0.25, harmonic3: 0.08 }, // C6
      { freq: 783.99, startSec: 0.36, durationSec: 0.18, gain: 0.50, harmonic2: 0.28, harmonic3: 0.09 },  // G5
      { freq: 1318.51, startSec: 0.47, durationSec: 0.29, gain: 0.58, harmonic2: 0.24, harmonic3: 0.07 }, // E6
    ],
  },
];

let createdCount = 0;
let preservedCount = 0;

for (const spec of CANDIDATE_SOUNDS) {
  const outPath = path.join(soundsDir, spec.filename);
  if (!forceOverwrite && fs.existsSync(outPath) && fs.statSync(outPath).size > 44) {
    preservedCount += 1;
    continue;
  }
  const buf = synthesizeWav(spec.notes, spec.durationSec);
  fs.writeFileSync(outPath, buf);
  createdCount += 1;
}

console.log(
  `[BEXORA Sounds] Notification sound check complete (${createdCount} generated, ${preservedCount} existing preserved in public/sounds/).`
);

// Sync matching Firebase compat scripts from node_modules/firebase into public/vendor/firebase/
// so public/firebase-messaging-sw.js always runs the exact same Firebase SDK version as the main app.
const vendorDir = path.resolve('public', 'vendor', 'firebase');
fs.mkdirSync(vendorDir, { recursive: true });
for (const swBundle of ['firebase-app-compat.js', 'firebase-messaging-compat.js']) {
  const srcBundle = path.resolve('node_modules', 'firebase', swBundle);
  if (fs.existsSync(srcBundle)) {
    const cleaned = fs
      .readFileSync(srcBundle, 'utf8')
      .replace(/\/\/#\s*sourceMappingURL=.*$/gm, '')
      .trimEnd();
    fs.writeFileSync(path.join(vendorDir, swBundle), `${cleaned}\n`, 'utf8');
  }
}
console.log('[BEXORA FCM SW] Synced matching Firebase compat bundles to public/vendor/firebase/.');
