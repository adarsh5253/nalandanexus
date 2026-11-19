import { Router } from 'express';
import { readStoredFile } from '../services/fileStorage.service.js';
import { catchAsync } from '../utils/catchAsync.js';
import { ApiError } from '../utils/ApiError.js';

const router = Router();

// Public on purpose: a profile photo is embedded in the Teacher Portal and the
// student site's About page, loaded by browsers with no session here. Only
// images are ever stored (their type is checked from their bytes on the way in),
// and the id is an unguessable ObjectId.
router.get(
  '/:id',
  catchAsync(async (req, res) => {
    if (!/^[a-f\d]{24}$/i.test(req.params.id)) throw ApiError.notFound('File not found', 'FILE_NOT_FOUND');
    const file = await readStoredFile(req.params.id);
    if (!file) throw ApiError.notFound('File not found', 'FILE_NOT_FOUND');

    const bytes = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data.buffer);
    res.set({
      'Content-Type': file.contentType,
      'Content-Length': String(bytes.length),
      // Never let a browser second-guess the type, and let other origins embed it.
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'public, max-age=86400',
    });
    res.send(bytes);
  })
);

export default router;
