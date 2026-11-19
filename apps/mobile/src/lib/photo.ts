import { TASK_FILE_FORMATS } from '@crew/contracts';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';
import { type Api, fromBase64 } from './api';

export const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

export type PickedPhoto = { uri: string; mimeType: string; fileName: string; size: number | null; /** The photo itself, when the picker returned it. */ base64?: string | null };
export type PickResult = { ok: true; photo: PickedPhoto } | { ok: false; cancelled?: boolean; message?: string };

/** Checks a picked photo the way the API does, so the person hears about a problem before the upload. */
export function checkPhoto(p: { mimeType?: string | null; size?: number | null }): string | null {
  if (!p.mimeType || !PHOTO_TYPES.includes(p.mimeType)) return 'Choose a PNG, JPEG or WebP photo.';
  if (p.size != null && p.size > PHOTO_MAX_BYTES) return 'Photos can be up to 5 MB. Choose a smaller one.';
  return null;
}

/** Opens the photo library, or the camera, for a square profile photo. */
export async function pickPhoto(source: 'library' | 'camera'): Promise<PickResult> {
  const perm = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    return { ok: false, message: source === 'camera' ? 'SampCrew needs camera access to take your photo. Allow it in your phone settings.' : 'SampCrew needs access to your photos. Allow it in your phone settings.' };
  }
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.8, base64: true };
  const r = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  if (r.canceled || !r.assets[0]) return { ok: false, cancelled: true };
  const a = r.assets[0];
  // Edited photos come back as JPEG on phones; the web build keeps the original type.
  const mimeType = a.mimeType ?? (a.uri.startsWith('data:image/png') ? 'image/png' : 'image/jpeg');
  const problem = checkPhoto({ mimeType, size: a.fileSize ?? null });
  if (problem) return { ok: false, message: problem };
  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  return { ok: true, photo: { uri: a.uri, mimeType, fileName: a.fileName ?? `photo.${ext}`, size: a.fileSize ?? null, base64: a.base64 ?? null } };
}

/** The photo's bytes: from the picker's base64 copy, or (in the browser) read from its address. */
export async function photoBytes(p: PickedPhoto, read: (uri: string) => Promise<ArrayBuffer> = async (uri) => (await fetch(uri)).arrayBuffer()): Promise<Uint8Array> {
  if (p.base64) return fromBase64(p.base64.replace(/^data:[^,]*,/, ''));
  if (Platform.OS === 'web' || p.uri.startsWith('data:') || p.uri.startsWith('blob:')) return new Uint8Array(await read(p.uri));
  throw new Error('Could not read the file on this phone. Choose it again.');
}

/** Sends the photo to SampCrew as the employee's profile photo. */
export async function uploadPhoto(api: Api, employeeId: string, p: PickedPhoto) {
  const bytes = await photoBytes(p);
  if (!bytes.length) throw new Error('Could not read the photo. Choose it again.');
  if (bytes.length > PHOTO_MAX_BYTES) throw new Error('Photos can be up to 5 MB. Choose a smaller one.');
  return api.uploadFile<{ photoUpdatedAt: string }>('PUT', `/employees/${employeeId}/photo`, { field: 'file', fileName: p.fileName, type: p.mimeType, bytes });
}

/** Picks a photo of a document (a scan or a phone picture), uncropped, for a task that asks for one. */
export async function pickDocumentPhoto(source: 'library' | 'camera', maxBytes: number): Promise<PickResult> {
  const perm = source === 'camera' ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return { ok: false, message: source === 'camera' ? 'SampCrew needs camera access to photograph the document. Allow it in your phone settings.' : 'SampCrew needs access to your photos. Allow it in your phone settings.' };
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], allowsEditing: false, quality: 0.85, base64: true };
  const r = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  if (r.canceled || !r.assets[0]) return { ok: false, cancelled: true };
  const a = r.assets[0];
  const mimeType = a.mimeType ?? (a.uri.startsWith('data:image/png') ? 'image/png' : 'image/jpeg');
  if (!PHOTO_TYPES.includes(mimeType)) return { ok: false, message: 'Choose a PNG, JPEG or WebP picture.' };
  if (a.fileSize != null && a.fileSize > maxBytes) return { ok: false, message: `The file can be up to ${Math.round(maxBytes / 1048576)} MB. Choose a smaller one.` };
  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  return { ok: true, photo: { uri: a.uri, mimeType, fileName: a.fileName ?? `document.${ext}`, size: a.fileSize ?? null, base64: a.base64 ?? null } };
}

/** MIME types for each file format an HR document task can ask for (the same list the API checks). */
export const DOCUMENT_TYPES: Record<string, readonly string[]> = TASK_FILE_FORMATS;

/**
 * Picks a file (PDF, Word, text or a picture) from the phone's files for a task that asks for one. Only the formats
 * the task accepts can be chosen, and the size is checked before anything is sent.
 */
export async function pickDocumentFile(formats: readonly string[], maxBytes: number): Promise<PickResult> {
  const types = formats.flatMap((f) => DOCUMENT_TYPES[f] ?? []);
  const r = await DocumentPicker.getDocumentAsync({ type: types.length ? [...types] : '*/*', copyToCacheDirectory: true, multiple: false, base64: true });
  if (r.canceled || !r.assets?.[0]) return { ok: false, cancelled: true };
  const a = r.assets[0];
  const mimeType = a.mimeType ?? a.file?.type ?? mimeFromName(a.name);
  if (!mimeType || (types.length && !types.includes(mimeType))) return { ok: false, message: `This task accepts ${formats.map((f) => f.toUpperCase()).join(', ')} files. Choose another file.` };
  const size = a.size ?? a.file?.size ?? null;
  if (size != null && size > maxBytes) return { ok: false, message: `The file can be up to ${Math.round(maxBytes / 1048576)} MB. Choose a smaller one.` };
  return { ok: true, photo: { uri: a.uri, mimeType, fileName: a.name, size, base64: a.base64 ?? null } };
}

/** The MIME type for a file name, for pickers that leave it out. */
export function mimeFromName(name: string): string | null {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return ({ pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[ext] ?? null;
}
