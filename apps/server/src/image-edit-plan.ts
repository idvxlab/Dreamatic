import { imageDimensions, imageEditSizePolicy, type ImageDimensions } from './image-edit-size.js';
export interface EditSizeOptions { target?: ImageDimensions; confirmConflict?: boolean; acceptAdaptation?: boolean }
export interface EditCapabilities { sizes?: string[]; step?: number; maxPixels?: number; maxEdge?: number }
export function validDimensions(value: unknown): value is ImageDimensions {
  const v = value as ImageDimensions | undefined;
  return !!v && Number.isSafeInteger(v.width) && Number.isSafeInteger(v.height) && v.width > 0 && v.height > 0 && v.width <= 16384 && v.height <= 16384 && v.width * v.height <= 40_000_000;
}
export function editCapabilities(source: string): EditCapabilities | undefined {
  if (!source.trim()) return;
  const value = JSON.parse(source) as EditCapabilities;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['sizes','step','maxPixels','maxEdge'].includes(key))) throw new Error('Invalid image edit capabilities');
  if (value.sizes !== undefined && (!Array.isArray(value.sizes) || !value.sizes.length || value.sizes.some(size => typeof size !== 'string' || !/^\d+x\d+$/u.test(size) || !validDimensions(parseSize(size))))) throw new Error('Invalid image edit capability sizes');
  for (const key of ['step','maxPixels','maxEdge'] as const) if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key]! < 1)) throw new Error('Invalid image edit capability limit');
  if (!Object.keys(value).length) throw new Error('Image edit capabilities must declare at least one constraint');
  return value;
}
export function parseSize(size: string): ImageDimensions { const [width, height] = size.split('x').map(Number); return { width: width!, height: height! }; }
export const formatSize = (v: ImageDimensions) => `${v.width}x${v.height}`;
export function planImageEdit(source: ImageDimensions, prompt: string, fallback: string, capabilities?: EditCapabilities, options?: EditSizeOptions) {
  if (options?.target !== undefined && !validDimensions(options.target)) throw new Error('Invalid target image dimensions');
  const intent = imageEditSizePolicy(prompt, source, fallback);
  const target = options ? options.target ?? source : intent.expected ?? (intent.requestSize === 'auto' ? source : parseSize(intent.requestSize));
  if (!validDimensions(target)) throw new Error('Invalid target image dimensions');
  const conflict = !!options && intent.mode === 'resize' && (!intent.expected || formatSize(intent.expected) !== formatSize(target));
  const allowed = (v: ImageDimensions) => validDimensions(v) && (!capabilities?.step || (v.width % capabilities.step === 0 && v.height % capabilities.step === 0)) && (!capabilities?.maxPixels || v.width * v.height <= capabilities.maxPixels) && (!capabilities?.maxEdge || Math.max(v.width,v.height) <= capabilities.maxEdge);
  let request = target;
  if (capabilities) {
    let candidates: ImageDimensions[];
    if (capabilities.sizes) candidates = capabilities.sizes.map(parseSize).filter(allowed);
    else {
      const scale = Math.min(1, Math.sqrt((capabilities.maxPixels ?? 40_000_000)/(target.width*target.height)), (capabilities.maxEdge ?? 16384)/Math.max(target.width,target.height));
      const step = capabilities.step ?? 1;
      candidates = [{ width: Math.max(step,Math.floor(target.width*scale/step)*step),height: Math.max(step,Math.floor(target.height*scale/step)*step) }].filter(allowed);
    }
    if (!candidates.length) throw new Error('Image edit capabilities have no usable output size');
    request = candidates.sort((a,b) => score(a,target)-score(b,target))[0]!;
  }
  return { sourceDimensions: source, targetDimensions: target, requestSize: formatSize(request), capabilitiesKnown: !!capabilities, conflict, adapted: formatSize(request)!==formatSize(target) };
}
function score(v: ImageDimensions,t: ImageDimensions) { return Math.abs(Math.log((v.width/v.height)/(t.width/t.height)))*10+Math.abs(Math.log((v.width*v.height)/(t.width*t.height))); }
export function dimensionStatus(actual: ImageDimensions,target: ImageDimensions) {
  if (formatSize(actual)===formatSize(target)) return 'exact' as const;
  const delta=Math.abs((actual.width/actual.height)/(target.width/target.height)-1);
  return delta < .00001 ? 'same-ratio' as const : delta <= .01 ? 'near-ratio' as const : 'different-ratio' as const;
}
export { imageDimensions };
