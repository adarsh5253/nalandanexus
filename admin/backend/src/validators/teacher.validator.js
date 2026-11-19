import { z } from 'zod';
import { paginationQuery } from './common.js';

export const listTeachersQuery = {
  query: paginationQuery.extend({
    status: z.enum(['INVITED', 'ACTIVE', 'SUSPENDED', 'INACTIVE']).optional(),
    department: z.string().trim().max(100).optional(),
    subject: z.string().trim().max(100).optional(),
    // Teachers assigned a given course (its catalogue slug).
    course: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{1,100}$/).optional(),
  }),
};

// The public profile an admin may set on a teacher, shown on the student site's
// About page. Shared by create and update so the two cannot drift apart.
const publicProfileFields = {
  showOnWebsite: z.boolean().optional(),
  websiteRole: z.string().trim().max(160).optional().nullable(),
  websiteCategory: z.string().trim().max(80).optional().nullable(),
  expertise: z.array(z.string().trim().min(1).max(160)).max(12).optional(),
  experienceNote: z.string().trim().max(240).optional().nullable(),
  websiteOrder: z.coerce.number().int().min(0).max(9999).optional(),
};

/**
 * A course, by the student catalogue's slug. The catalogue is the only place
 * PRARAMBH, GARUD and YODDHA exist, so that is what identifies one; whether the
 * slug is real is checked against it when the request is handled.
 */
const courseSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]{1,100}$/, 'Invalid course');

// A photo is a URL - uploaded separately (POST /teachers/:id/photo) or an
// existing one. Never inline image data: the record is broadcast and listed.
const photoUrl = z
  .string()
  .trim()
  .max(2000)
  .url()
  // http(s) only: `data:` and `javascript:` are valid URLs too, and neither
  // belongs in an image address that is broadcast, listed and embedded.
  .regex(/^https?:\/\//i, 'The photo must be an http(s) address');

export const createTeacherSchema = {
  body: z
    .object({
      name: z.string().trim().min(2).max(120),
      email: z.string().trim().email().max(254),
      // Required (as "Subject / Department"): a teacher needs to be placed
      // somewhere. Either field satisfies it; the form sends the one it shows.
      subject: z.string().trim().min(1).max(100).optional(),
      department: z.string().trim().min(1).max(100).optional(),
      // Required: at least one course, so a new teacher is never created able to
      // see nothing. More can be added or removed later.
      courseSlugs: z.array(courseSlug).min(1, 'Assign at least one course').max(20),
      phone: z.string().trim().max(20).optional(),
      designation: z.string().trim().max(160).optional(),
      avatar: photoUrl.optional(),
      qualification: z.string().trim().max(200).optional(),
      ...publicProfileFields,
    })
    .refine((v) => Boolean(v.subject || v.department), {
      message: 'Subject or department is required',
      path: ['subject'],
    }),
};

export const updateTeacherSchema = {
  body: z
    .object({
      name: z.string().trim().min(2).max(120).optional(),
      phone: z.string().trim().max(20).optional(),
      department: z.string().trim().max(100).optional(),
      subject: z.string().trim().max(100).optional(),
      qualification: z.string().trim().max(200).optional(),
      designation: z.string().trim().max(160).optional(),
      avatar: photoUrl.optional(),
      ...publicProfileFields,
    })
    .strict(),
};

/** The full set of courses for one teacher - a replacement, so an empty list removes them all. */
export const setTeacherCoursesSchema = {
  body: z.object({ courseSlugs: z.array(courseSlug).max(20) }).strict(),
};

export const suspendTeacherSchema = {
  body: z.object({ reason: z.string().trim().min(3).max(500) }),
};

export const activateTeacherSchema = {
  body: z.object({
    token: z.string().min(10),
    password: z
      .string()
      .min(8)
      .regex(/[A-Z]/, 'Password must contain an uppercase letter')
      .regex(/[0-9]/, 'Password must contain a number'),
  }),
};

export default {
  listTeachersQuery,
  createTeacherSchema,
  updateTeacherSchema,
  setTeacherCoursesSchema,
  suspendTeacherSchema,
  activateTeacherSchema,
};
