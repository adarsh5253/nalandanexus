import { Router } from 'express';
import * as authController from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rateLimiter.js';
import { validate } from '../middleware/validate.js';
import {
  loginValidator,
  changePasswordValidator,
  inspectPasswordSetupValidator,
  completePasswordSetupValidator,
} from '../validators/auth.validators.js';

const router = Router();

router.post('/login', authLimiter, loginValidator, validate, authController.login);
router.post('/logout', authenticate, authController.logout);
router.post('/logout-all', authenticate, authController.logoutAllSessions);
router.get('/me', authenticate, authController.me);
router.post('/change-password', authenticate, changePasswordValidator, validate, authController.changePassword);

// Public by necessity: the person following an emailed link has no account
// credentials yet. The link's token is the credential - single use, expiring,
// and stored only as a hash - and these share the login limiter so it cannot be
// guessed at faster than a password could.
router.get('/setup-password/:token', authLimiter, inspectPasswordSetupValidator, validate, authController.inspectPasswordSetup);
router.post('/setup-password', authLimiter, completePasswordSetupValidator, validate, authController.completePasswordSetup);

export default router;
