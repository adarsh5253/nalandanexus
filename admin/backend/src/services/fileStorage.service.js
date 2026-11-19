import { StoredFile } from '../models/StoredFile.js';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';

const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

/**
 * What the bytes actually are, from their first few bytes - not from the
 * Content-Type the client declared, which is whatever it chose to say. Returns
 * the real type, or null for anything that is not one of the allowed images.
 */
export function sniffImageType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  return null;
}

/** Stores a teacher's photo (replacing any earlier one) and returns the public URL it is served from. */
export async function storeTeacherPhoto({ ownerId, file }) {
  if (file.size > MAX_PHOTO_BYTES) throw ApiError.badRequest('The photo must be 2 MB or smaller.', 'FILE_TOO_LARGE');
  const contentType = sniffImageType(file.buffer);
  if (!contentType) throw ApiError.badRequest('The photo must be a PNG, JPEG, WebP or GIF image.', 'FILE_TYPE_NOT_ALLOWED');

  await StoredFile.deleteMany({ ownerId, kind: 'teacher-photo' });
  const stored = await StoredFile.create({ ownerId, kind: 'teacher-photo', contentType, sizeBytes: file.size, data: file.buffer });
  // The admin API is mounted under /api/admin (see app.js); the file route is
  // public within it.
  return `${env.serverUrl.replace(/\/+$/, '')}/api/admin/files/${stored._id}`;
}

export async function readStoredFile(id) {
  return StoredFile.findById(id).lean();
}

export default { storeTeacherPhoto, readStoredFile, sniffImageType };
