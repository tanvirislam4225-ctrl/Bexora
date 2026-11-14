import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadListingImagesToStorage } from './listingStorage';
import { MAX_LISTING_IMAGES } from './listingAndBidManagementLogic';

function makeDummyDataUrl(index: number): string {
  return `data:image/png;base64,DUMMY_${index}`;
}

test('uploadListingImagesToStorage: 3 data-URL inputs upload image 0 once as cover and return exactly 3 URLs', async () => {
  const uploaded: Array<{ fileName: string; maxDimension: number; sourceDataUrl: string }> = [];
  const urls = await uploadListingImagesToStorage(
    {
      userId: 'user_1',
      listingId: 'lst_1',
      images: [makeDummyDataUrl(0), makeDummyDataUrl(1), makeDummyDataUrl(2)],
    },
    {
      encodeAndUpload: async (opts) => {
        uploaded.push({
          fileName: opts.fileName,
          maxDimension: opts.maxDimension,
          sourceDataUrl: opts.sourceDataUrl,
        });
        return `https://firebasestorage.googleapis.com/v0/b/bexora/o/${opts.fileName}`;
      },
    }
  );

  assert.equal(urls.length, 3);
  assert.equal(uploaded.length, 3);
  assert.match(uploaded[0]!.fileName, /^cover_480_/);
  assert.equal(uploaded[0]!.maxDimension, 480);
  assert.equal(uploaded[0]!.sourceDataUrl, makeDummyDataUrl(0));
  assert.match(uploaded[1]!.fileName, /^img_1_/);
  assert.equal(uploaded[1]!.maxDimension, 1280);
  assert.match(uploaded[2]!.fileName, /^img_2_/);
  assert.equal(uploaded[2]!.maxDimension, 1280);
});

test('uploadListingImagesToStorage: 10 data-URL inputs return all 10 URLs without dropping the last photo', async () => {
  const inputs = Array.from({ length: MAX_LISTING_IMAGES }, (_, i) => makeDummyDataUrl(i));
  const uploadedSources: string[] = [];

  const urls = await uploadListingImagesToStorage(
    {
      userId: 'user_1',
      listingId: 'lst_10',
      images: inputs,
    },
    {
      encodeAndUpload: async (opts) => {
        uploadedSources.push(opts.sourceDataUrl);
        return `https://firebasestorage.googleapis.com/v0/b/bexora/o/${opts.fileName}`;
      },
    }
  );

  assert.equal(MAX_LISTING_IMAGES, 10);
  assert.equal(urls.length, 10);
  assert.deepEqual(uploadedSources, inputs);
  assert.equal(new Set(urls).size, 10);
});
