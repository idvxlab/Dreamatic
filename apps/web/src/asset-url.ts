export function assetUrl(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  return `/assets/${normalized.split("/").map((segment) => encodeURIComponent(segment)).join("/")}`;
}
