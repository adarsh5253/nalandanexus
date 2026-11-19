import { apiClient } from './apiClient';

/**
 * The teaching faculty shown on the About page.
 *
 * Public and unauthenticated, and backed by real records the admin portal
 * publishes (see backend/src/controllers/public.controller.js
 * #listPublicFaculty). The page used to read a hardcoded list, so introducing
 * an instructor meant a deploy; it is now an administrative act.
 */
export const facultyService = {
  async listPublicFaculty(limit = 50) {
    const res = await apiClient.get(`/public/faculty?limit=${limit}`);
    return res.data;
  },
};

export default facultyService;
