import { getDownloadURL, ref, uploadBytes } from 'firebase/storage';
import { storage } from './firebase';
import { MAX_LISTING_IMAGES } from './listingAndBidManagementLogic';

const COVER_MAX_DIMENSION = 480;
const COVER_JPEG_QUALITY = 0.7;
const FULL_MAX_DIMENSION = 1280;
const FULL_JPEG_QUALITY = 0.8;

export function buildListingImageStoragePath(
  userId: string,
  listingId: string,
  fileName: string
): string {
  const safeUid = String(userId || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
  const safeListingId = String(listingId || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
  const safeFile = String(fileName || 'image.jpg').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
  return `listing_images/${safeUid}/${safeListingId}/${safeFile}`;
}

export function hasPendingDataUrlImages(images: string[]): boolean {
  return Array.isArray(images) && images.some((src) => typeof src === 'string' && src.startsWith('data:image/'));
}

async function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not decode listing image for upload.'));
    img.src = src;
  });
}

async function encodeImageToJpegBlob(
  dataUrl: string,
  maxDimension: number,
  quality: number
): Promise<Blob> {
  if (typeof document === 'undefined') {
    throw new Error('Image canvas encoding is only available in the browser.');
  }
  const img = await loadImageElement(dataUrl);
  let width = img.naturalWidth || img.width || maxDimension;
  let height = img.naturalHeight || img.height || maxDimension;
  if (width > maxDimension || height > maxDimension) {
    const ratio = Math.min(maxDimension / width, maxDimension / height);
    width = Math.max(1, Math.round(width * ratio));
    height = Math.max(1, Math.round(height * ratio));
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Browser canvas context is unavailable for image upload.');
  }
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob || blob.size === 0) {
          reject(new Error('Failed to encode JPEG image blob.'));
          return;
        }
        resolve(blob);
      },
      'image/jpeg',
      quality
    );
  });
}

async function uploadJpegBlob(storagePath: string, blob: Blob): Promise<string> {
  const storageRef = ref(storage, storagePath);
  const snapshot = await uploadBytes(storageRef, blob, {
    contentType: 'image/jpeg',
    cacheControl: 'public, max-age=31536000, immutable',
  });
  return getDownloadURL(snapshot.ref);
}

export interface UploadListingImagesHooks {
  encodeAndUpload?: (opts: {
    userId: string;
    listingId: string;
    fileName: string;
    sourceDataUrl: string;
    maxDimension: number;
    quality: number;
  }) => Promise<string>;
}

/**
 * Uploads any newly picked `data:image/...` showcase images to Firebase Storage under
 * `listing_images/{userId}/{listingId}/{fileName}` and returns `https://` download URLs.
 * When index 0 is a new `data:image/...`, it is uploaded ONCE as a ~480px JPEG cover (quality 0.7)
 * so it is never duplicated and never pushes the 10th photo past `MAX_LISTING_IMAGES`.
 * Existing `https://` URLs are preserved in order and deduplicated before slicing.
 */
export async function uploadListingImagesToStorage(
  params: {
    userId: string;
    listingId: string;
    images: string[];
  },
  hooks?: UploadListingImagesHooks
): Promise<string[]> {
  const { userId, listingId, images } = params;
  const dedupedInputs: string[] = [];
  const seenInputs = new Set<string>();
  for (const raw of Array.isArray(images) ? images : []) {
    const clean = String(raw || '').trim();
    if (!clean || seenInputs.has(clean)) continue;
    seenInputs.add(clean);
    dedupedInputs.push(clean);
  }
  const cleanInputs = dedupedInputs.slice(0, MAX_LISTING_IMAGES);

  if (cleanInputs.length === 0) return [];
  if (!hasPendingDataUrlImages(cleanInputs)) {
    return cleanInputs;
  }

  const encodeAndUpload =
    hooks?.encodeAndUpload ||
    (async (opts: {
      userId: string;
      listingId: string;
      fileName: string;
      sourceDataUrl: string;
      maxDimension: number;
      quality: number;
    }) => {
      const blob = await encodeImageToJpegBlob(opts.sourceDataUrl, opts.maxDimension, opts.quality);
      const storagePath = buildListingImageStoragePath(opts.userId, opts.listingId, opts.fileName);
      return uploadJpegBlob(storagePath, blob);
    });

  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);

  const uploadedUrls: string[] = [];
  for (let idx = 0; idx < cleanInputs.length; idx++) {
    const src = cleanInputs[idx];
    if (src.startsWith('https://')) {
      uploadedUrls.push(src);
      continue;
    }
    if (!src.startsWith('data:image/')) {
      continue;
    }
    const isCover = idx === 0;
    const url = await encodeAndUpload({
      userId,
      listingId,
      fileName: isCover ? `cover_480_${ts}_${rand}.jpg` : `img_${idx}_${ts}_${rand}.jpg`,
      sourceDataUrl: src,
      maxDimension: isCover ? COVER_MAX_DIMENSION : FULL_MAX_DIMENSION,
      quality: isCover ? COVER_JPEG_QUALITY : FULL_JPEG_QUALITY,
    });
    uploadedUrls.push(url);
  }

  const dedupedUrls: string[] = [];
  const seenUrls = new Set<string>();
  for (const url of uploadedUrls) {
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    dedupedUrls.push(url);
  }
  return dedupedUrls.slice(0, MAX_LISTING_IMAGES);
}
