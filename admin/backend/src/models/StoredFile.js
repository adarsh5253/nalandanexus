import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * An uploaded file, kept in MongoDB rather than on the container's disk.
 *
 * The host wipes local storage on every redeploy, so a photo written to disk
 * keeps a URL on the teacher's record that 404s from the next deploy onward. The
 * bytes live here instead and are served back by routes/file.routes.js. Only
 * small images are stored (see services/fileStorage.service.js), which is what
 * keeps this reasonable: a profile photo is tens of kilobytes.
 */
const storedFileSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true, index: true },
    kind: { type: String, enum: ['teacher-photo'], required: true },
    contentType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    data: { type: Buffer, required: true },
  },
  { timestamps: true }
);

export const StoredFile = mongoose.model('StoredFile', storedFileSchema);
export default StoredFile;
