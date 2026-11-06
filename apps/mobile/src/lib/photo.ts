import * as ImagePicker from 'expo-image-picker';
import { Platform } from 'react-native';
import type { Api } from './api';

export const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

export type PickedPhoto = { uri: string; mimeType: string; fileName: string; size: number | null };
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
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.8 };
  const r = source === 'camera' ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  if (r.canceled || !r.assets[0]) return { ok: false, cancelled: true };
  const a = r.assets[0];
  // Edited photos come back as JPEG on phones; the web build keeps the original type.
  const mimeType = a.mimeType ?? (a.uri.startsWith('data:image/png') ? 'image/png' : 'image/jpeg');
  const problem = checkPhoto({ mimeType, size: a.fileSize ?? null });
  if (problem) return { ok: false, message: problem };
  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  return { ok: true, photo: { uri: a.uri, mimeType, fileName: a.fileName ?? `photo.${ext}`, size: a.fileSize ?? null } };
}

/** Sends the photo to SampCrew as the employee's profile photo. */
export async function uploadPhoto(api: Api, employeeId: string, p: PickedPhoto) {
  const form = new FormData();
  if (Platform.OS === 'web') {
    const blob = await (await fetch(p.uri)).blob();
    if (blob.size > PHOTO_MAX_BYTES) throw new Error('Photos can be up to 5 MB. Choose a smaller one.');
    form.append('file', new File([blob], p.fileName, { type: p.mimeType }));
  } else {
    // React Native sends a { uri, name, type } entry as the file itself.
    form.append('file', { uri: p.uri, name: p.fileName, type: p.mimeType } as unknown as Blob);
  }
  return api.upload<{ photoUpdatedAt: string }>('PUT', `/employees/${employeeId}/photo`, form);
}
