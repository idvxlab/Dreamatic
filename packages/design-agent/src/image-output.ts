import { extname } from "node:path";
import { PhotonImage } from "@silvia-odwyer/photon-node";

/** One encoding contract shared by draft validation, tools and saved artifacts. */
export const IMAGE_OUTPUT_FORMATS = [
  { format: "png", extensions: [".png"], mimeType: "image/png", lossless: true, transparency: true },
  { format: "jpeg", extensions: [".jpg", ".jpeg"], mimeType: "image/jpeg", lossless: false, transparency: false },
] as const;
export type ImageOutputFormat = "png" | "jpeg";
export type ImageOutputMime = "image/png" | "image/jpeg";
export function imageOutputFormat(path: string, label = "Image output path"): ImageOutputFormat {
  const extension = extname(path).toLowerCase();
  const format = IMAGE_OUTPUT_FORMATS.find((item) => (item.extensions as readonly string[]).includes(extension));
  if (!format) throw new Error(`${label} must use .png, .jpg or .jpeg; unsupported extension: ${extension || "none"}`);
  return format.format;
}
export function imageEncoding(bytes: Uint8Array): ImageOutputFormat | undefined {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "png";
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpeg";
  return undefined;
}
export function imageBytesMatchPath(bytes: Uint8Array, path: string): boolean {
  return imageEncoding(bytes) === imageOutputFormat(path);
}

/** Keep the agreed filename. Encode the actual provider bytes, never just rename them. */
export function encodeImageOutput(bytes: Buffer, path: string) {
  const format = imageOutputFormat(path), sourceFormat = imageEncoding(bytes);
  if (!sourceFormat) throw new Error("Image provider returned unsupported image bytes; expected PNG or JPEG");
  const mimeType: ImageOutputMime = format === "png" ? "image/png" : "image/jpeg";
  if (format === sourceFormat) return { bytes, mimeType, format, sourceFormat, converted: false };
  const image = PhotonImage.new_from_byteslice(bytes);
  try {
    const encoded = Buffer.from(format === "png" ? image.get_bytes() : image.get_bytes_jpeg(95));
    if (!imageBytesMatchPath(encoded, path)) throw new Error("Image encoder returned an unexpected encoding");
    return { bytes: encoded, mimeType, format, sourceFormat, converted: true, ...(format === "jpeg" ? { quality: 95 } : {}) };
  } finally { image.free(); }
}
