import test from 'node:test';
import assert from 'node:assert/strict';
import { imageDimensions, imageEditSizePolicy } from '../dist/image-edit-size.js';
const source = { width: 1600, height: 900 };
test('edit size permission preserves source dimensions unless the user explicitly requests output geometry changes', () => {
  for (const prompt of ['Change the background to blue', 'Make the logo bigger', '把背景改成正方形花纹', 'resize the logo to 800x600', '把人物放大两倍', '把logo改成800x600', 'Do not resize the image', '不要调整图片尺寸，只修改背景', '保持原图大小，改变光照', 'Add text "1024x1024"', '保持画幅不变，调整人物大小']) {
    assert.deepEqual(imageEditSizePolicy(prompt, source, '1024x1024'), { mode: 'preserve', requestSize: '1600x900', expected: source }, prompt);
  }
  for (const prompt of ['Resize the image to 800x600', '请将图片尺寸改为 800×600', '输出尺寸800x600', '800x600']) {
    assert.deepEqual(imageEditSizePolicy(prompt, source, 'auto'), { mode: 'resize', requestSize: '800x600', expected: { width: 800, height: 600 } }, prompt);
  }
  for (const prompt of ['调整图片尺寸', '请修改尺寸', '改成16:9横版', 'Change the aspect ratio to 16:9', 'Upscale the image', 'Expand the canvas']) {
    assert.deepEqual(imageEditSizePolicy(prompt, source, 'auto'), { mode: 'resize', requestSize: 'auto' }, prompt);
  }
});
test('pixel geometry reads PNG, progressive/baseline JPEG and all three WebP headers, rejecting truncated data', () => {
  const png = Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.write('IHDR',12);png.writeUInt32BE(1600,16);png.writeUInt32BE(900,20);
  assert.deepEqual(imageDimensions(png),source);
  for (const marker of [0xc0,0xc2]) {
    const jpeg=Buffer.from([0xff,0xd8,0xff,0xe0,0,4,0,0,0xff,marker,0,8,8,3,132,6,64,1]);
    assert.deepEqual(imageDimensions(jpeg),source); assert.equal(imageDimensions(jpeg.subarray(0,-1)),undefined);
  }
  function webp(tag,data) {const bytes=Buffer.alloc(20+data.length);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WEBP',8);bytes.write(tag,12);bytes.writeUInt32LE(data.length,16);data.copy(bytes,20);return bytes;}
  const extended=Buffer.alloc(10);extended.writeUIntLE(1599,4,3);extended.writeUIntLE(899,7,3);
  const lossless=Buffer.alloc(5);lossless[0]=0x2f;lossless.writeUInt32LE(1599|(899<<14),1);
  const lossy=Buffer.alloc(10);Buffer.from([0x9d,0x01,0x2a]).copy(lossy,3);lossy.writeUInt16LE(1600,6);lossy.writeUInt16LE(900,8);
  for (const bytes of [webp('VP8X',extended),webp('VP8L',lossless),webp('VP8 ',lossy)]) {assert.deepEqual(imageDimensions(bytes),source);assert.equal(imageDimensions(bytes.subarray(0,-1)),undefined);}
  for (const bytes of [Buffer.alloc(0),Buffer.from('not an image'),png.subarray(0,23)]) assert.equal(imageDimensions(bytes),undefined);
});
