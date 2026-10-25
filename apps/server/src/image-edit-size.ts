export interface ImageDimensions { width: number; height: number }

/** Read pixel geometry from supported image headers without decoding or changing source bytes. */
export function imageDimensions(bytes: Buffer): ImageDimensions | undefined {
  let width = 0, height = 0;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) return;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) return;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) return;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (length < 8) return;
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += length;
    }
  } else if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const tag = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8;
      if (start + length > bytes.length) return;
      if (tag === 'VP8X' && length >= 10) { width = 1 + bytes.readUIntLE(start + 4, 3); height = 1 + bytes.readUIntLE(start + 7, 3); break; }
      if (tag === 'VP8L' && length >= 5 && bytes[start] === 0x2f) {
        const bits = bytes.readUInt32LE(start + 1); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; break;
      }
      if (tag === 'VP8 ' && length >= 10 && bytes.subarray(start + 3, start + 6).equals(Buffer.from([0x9d,0x01,0x2a]))) {
        width = bytes.readUInt16LE(start + 6) & 0x3fff; height = bytes.readUInt16LE(start + 8) & 0x3fff; break;
      }
      offset = start + length + (length % 2);
    }
  }
  if (width > 0 && height > 0) return { width, height };
}
const size = ({ width, height }: ImageDimensions) => `${width}x${height}`;

/** Permission is derived from the user's original request, never an agent's rewritten prompt. */
export function imageEditSizePolicy(originalPrompt: string, source: ImageDimensions, resizeFallback: string) {
  // Remove quoted content and negative instructions: neither authorizes an output resize.
  const unquoted = originalPrompt.replace(/"[^"\n]*"|'[^'\n]*'|“[^”\n]*”|「[^」\n]*」/gu, '')
    .replace(/(?:不要|不许|无需|不用|禁止|保持|保留)[^，。；\n]*?(?:尺寸|大小|分辨率|比例|画幅)[^，。；\n]*/gu, '')
    .replace(/(?:do not|don't|never|without|keep|preserve|maintain)\b[^,.;\n]*(?:resiz\w*|dimensions?|resolution|aspect ratio|canvas size|image size)[^,.;\n]*/giu, '');
  const intent = unquoted.split(/[,.;，。；\n]/u).filter(clause => {
    const contentObject = /\b(?:logo|text|font|subject|object|icon|face)\b|人物|主体|标志|文字|字体|图标|物体/iu.test(clause);
    const outputGeometry = /图片尺寸|图像尺寸|图片大小|图像大小|画布|画幅|输出尺寸|整张图|\b(?:image|canvas|output|photo|picture)\s+(?:size|dimensions|resolution)\b|\b(?:resize|rescale|upscale|downscale)\s+(?:the\s+)?(?:image|photo|picture|canvas|output)\b/iu.test(clause);
    return !contentObject || outputGeometry;
  }).join('\n');
  const numeric = /(?:调整|修改|改为|改成|变成|设为|设置|输出|生成|尺寸|大小|分辨率|resize|rescale|output|dimensions?|resolution|image size|canvas size|size)[^，。；\n]{0,35}?\b([1-9]\d{0,5})\s*[x×*]\s*([1-9]\d{0,5})\b/iu.exec(intent)
    ?? /^\s*([1-9]\d{0,5})\s*[x×*]\s*([1-9]\d{0,5})\s*(?:px|像素)?\s*$/iu.exec(intent);
  if (numeric) {
    const target = { width: Number(numeric[1]), height: Number(numeric[2]) };
    return { mode: 'resize' as const, requestSize: size(target), expected: target };
  }
  const resize = /(?:调整|修改|改变|更改|提高|提升|降低|放大|缩小|扩大|扩展|裁剪|裁切|改成|改为|变成|设为|设置)[^，。；\n]{0,18}(?:图片尺寸|图像尺寸|画布|画幅|分辨率|宽高比|纵横比|比例|\d+\s*[:：]\s*\d+)|(?:改成|改为|变成|设为|调整为)[^，。；\n]{0,8}(?:横版|竖版|方形|正方形)(?:图片|图像|画幅|画布)?\s*$|(?:调整|修改|改变)(?:一下)?尺寸|(?:图片|图像|画布)[^，。；\n]{0,8}(?:放大|缩小|扩展|裁剪|裁切)|(?:图片|图像|画布|画幅|输出)[^，。；\n]{0,8}(?:尺寸|大小|分辨率)[^，。；\n]{0,8}(?:调整|修改|改变|放大|缩小)|(?:放大|缩小)(?:整张)?(?:图片|图像)|\b(?:resize|rescale|upscale|downscale)\b(?=\s*(?:$|to\b|by\b|(?:the\s+)?(?:image|photo|picture|output|canvas)\b))|\b(?:change|adjust|set)\b[^,.;\n]{0,24}\b(?:image size|canvas size|dimensions|resolution|aspect ratio)\b|\b(?:crop|expand|extend)\b[^,.;\n]{0,20}\b(?:canvas|image|photo|picture|square|portrait|landscape|\d+\s*:\s*\d+)\b/iu.test(intent);
  return resize ? { mode: 'resize' as const, requestSize: resizeFallback } : { mode: 'preserve' as const, requestSize: size(source), expected: source };
}
