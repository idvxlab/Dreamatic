import { PhotonImage, SamplingFilter, resize as photonResize } from "@silvia-odwyer/photon-node";

export interface ModelImagePreview {
  data: string;
  mimeType: "image/jpeg" | string;
  originalWidth?: number;
  originalHeight?: number;
  width?: number;
  height?: number;
  bytes: number;
}

/**
 * Bound visual observations independently of the full-resolution Run asset.
 * This is deliberately stricter than Pi's provider-limit resize: design
 * workflows inspect many images per stage and therefore need a per-image
 * context budget, not only a per-request maximum.
 */
export function createModelImagePreview(bytes: Uint8Array, mimeType: string): ModelImagePreview {
  const maxEdge = Math.max(640, Number(process.env.DREAMATIC_VISUAL_PREVIEW_MAX_EDGE ?? 1400));
  const maxBytes = Math.max(200_000, Number(process.env.DREAMATIC_VISUAL_PREVIEW_MAX_BYTES ?? 1_200_000));
  let source: PhotonImage | undefined;
  try {
    source = PhotonImage.new_from_byteslice(bytes);
    const originalWidth = source.get_width();
    const originalHeight = source.get_height();
    const scale = Math.min(1, maxEdge / Math.max(originalWidth, originalHeight));
    let width = Math.max(1, Math.round(originalWidth * scale));
    let height = Math.max(1, Math.round(originalHeight * scale));

    while (true) {
      const preview = photonResize(source, width, height, SamplingFilter.Lanczos3);
      try {
        for (const quality of [78, 68, 58, 46]) {
          const encoded = preview.get_bytes_jpeg(quality);
          if (encoded.byteLength <= maxBytes || (width <= 640 && height <= 640)) {
            return {
              data: Buffer.from(encoded).toString("base64"),
              mimeType: "image/jpeg",
              originalWidth,
              originalHeight,
              width,
              height,
              bytes: encoded.byteLength,
            };
          }
        }
      } finally {
        preview.free();
      }
      width = Math.max(1, Math.round(width * .78));
      height = Math.max(1, Math.round(height * .78));
    }
  } catch {
    if (bytes.byteLength > maxBytes) {
      throw new Error(`Could not create a bounded visual preview from ${mimeType} (${bytes.byteLength} bytes)`);
    }
    return { data: Buffer.from(bytes).toString("base64"), mimeType, bytes: bytes.byteLength };
  } finally {
    source?.free();
  }
}
