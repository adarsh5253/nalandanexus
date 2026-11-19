import { catchAsync } from '../utils/catchAsync.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { authCookieOptions } from '../utils/tokens.js';
import { env } from '../config/env.js';
import * as authService from '../services/auth.service.js';
import * as teacherService from '../services/teacher.service.js';

export const login = catchAsync(async (req, res) => {
  const { email, password, rememberMe } = req.body;
  const { token, user, teacher } = await authService.loginTeacher({ email, password, rememberMe, ip: req.ip });

  res.cookie(env.cookieName, token, authCookieOptions(Boolean(rememberMe)));
  sendSuccess(res, {
    message: 'Signed in successfully.',
    data: { user: teacher.toSafeJSON(user) },
  });
});

export const logout = catchAsync(async (req, res) => {
  await authService.logoutTeacher({ teacherId: req.teacher?._id, ip: req.ip });
  res.clearCookie(env.cookieName, authCookieOptions(false));
  sendSuccess(res, { message: 'Signed out successfully.', data: null });
});

export const logoutAllSessions = catchAsync(async (req, res) => {
  await authService.invalidateAllSessions(req.user._id);
  res.clearCookie(env.cookieName, authCookieOptions(false));
  sendSuccess(res, { message: 'Signed out of all devices.', data: null });
});

export const me = catchAsync(async (req, res) => {
  const profile = await teacherService.getProfile(req.teacher._id);
  sendSuccess(res, { data: { user: profile } });
});

export const changePassword = catchAsync(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const token = await authService.changePassword({
    userId: req.user._id,
    currentPassword,
    newPassword,
    teacherId: req.teacher._id,
    ip: req.ip,
  });
  res.cookie(env.cookieName, token, authCookieOptions(false));
  sendSuccess(res, { message: 'Password updated successfully.', data: null });
});

/** Public: what the password-setup page may show for a link, before anything is chosen. */
export const inspectPasswordSetup = catchAsync(async (req, res) => {
  const details = await authService.inspectPasswordSetup(req.params.token);
  sendSuccess(res, { data: details });
});

/** Public: redeems a single-use link. Does not sign anyone in - the person signs in with the password they just chose. */
export const completePasswordSetup = catchAsync(async (req, res) => {
  const { email, teacherId } = await authService.completePasswordSetup({ token: req.body.token, password: req.body.password, ip: req.ip });
  sendSuccess(res, { message: 'Your password has been set. You can now sign in.', data: { email, teacherId } });
});

export default { login, logout, logoutAllSessions, me, changePassword, inspectPasswordSetup, completePasswordSetup };
