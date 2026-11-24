import type { StoragePrivacy } from '../privacy';
import type { ImageRecipe } from './image-recipe';

const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0';
const XMP_OPEN = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:sfh="urn:agent-runtime:generation-recipe:1"><sfh:manifest>';
const XMP_CLOSE = '</sfh:manifest></rdf:Description></rdf:RDF></x:xmpmeta>';
const RECIPE_SCHEMA = 'agent-runtime.generation-recipe';

export const embedImageRecipe = (params: { bytes: Uint8Array; recipe: ImageRecipe; privacy: StoragePrivacy }): Uint8Array => {
  if (params.bytes[0] !== 0xff || params.bytes[1] !== 0xd8) throw new Error('Cannot embed generation recipe in non-JPEG image');
  const manifest = params.privacy.encryptImageMetadata(JSON.stringify({ schema: RECIPE_SCHEMA, version: 1, recipe: params.recipe }));
  const xmp = `${XMP_OPEN}${manifest}${XMP_CLOSE}`;
  const payload = Buffer.concat([Buffer.from(XMP_HEADER), Buffer.from(xmp)]);
  if (payload.byteLength > 65_533) throw new Error('Generation recipe metadata exceeds JPEG APP1 capacity');
  const segment = Buffer.allocUnsafe(payload.byteLength + 4);
  segment.set([0xff, 0xe1]);
  segment.writeUInt16BE(payload.byteLength + 2, 2);
  segment.set(payload, 4);
  return Buffer.concat([Buffer.from(params.bytes.subarray(0, 2)), segment, Buffer.from(params.bytes.subarray(2))]);
};

export const extractImageRecipe = (params: { bytes: Uint8Array; privacy: StoragePrivacy }): ImageRecipe | null => {
  if (params.bytes[0] !== 0xff || params.bytes[1] !== 0xd8 || params.bytes[2] !== 0xff || params.bytes[3] !== 0xe1 || params.bytes.byteLength < 6) return null;
  const segmentLength = Buffer.from(params.bytes.buffer, params.bytes.byteOffset, params.bytes.byteLength).readUInt16BE(4);
  const segmentEnd = segmentLength + 4;
  if (segmentLength < 2 || segmentEnd > params.bytes.byteLength) return null;
  const xmp = Buffer.from(params.bytes.subarray(6, segmentEnd)).toString();
  const open = `${XMP_HEADER}${XMP_OPEN}`;
  if (!xmp.startsWith(open) || !xmp.endsWith(XMP_CLOSE)) return null;
  const encrypted = xmp.slice(open.length, -XMP_CLOSE.length);
  try {
    const envelope = JSON.parse(params.privacy.decryptImageMetadata(encrypted)) as { schema?: unknown; version?: unknown; recipe?: unknown };
    if (envelope.schema !== RECIPE_SCHEMA || envelope.version !== 1 || typeof envelope.recipe !== 'object' || envelope.recipe === null || !('version' in envelope.recipe) || envelope.recipe.version !== 1) return null;
    return envelope.recipe as ImageRecipe;
  } catch {
    return null;
  }
};
