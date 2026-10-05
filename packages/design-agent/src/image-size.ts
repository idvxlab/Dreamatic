export function parseImageSize(value: string, label: string): [number, number] {
  const match = value.trim().match(/^(\d+)x(\d+)$/u);
  if (!match) throw new Error(`${label} must use WIDTHxHEIGHT pixels`);
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new Error(`${label} must contain positive integer dimensions`);
  return [width, height];
}

export function imageSizeCeiling(): string {
  return process.env.DREAMATIC_IMAGE_DEFAULT_SIZE?.trim() || "1536x1024";
}

export function assertImageSizeWithinCeiling(value: string, label: string): void {
  const requested = parseImageSize(value, label).sort((left, right) => right - left);
  const ceiling = parseImageSize(imageSizeCeiling(), "DREAMATIC_IMAGE_DEFAULT_SIZE").sort((left, right) => right - left);
  if (requested[0] > ceiling[0] || requested[1] > ceiling[1]) {
    throw new Error(`${label} ${value} exceeds DREAMATIC_IMAGE_DEFAULT_SIZE ceiling ${imageSizeCeiling()}`);
  }
}

