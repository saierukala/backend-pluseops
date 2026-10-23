import { AuthService } from './auth.service.js';
import { supportService } from '../support/support.service.js';

const authService = new AuthService();

// Recorded on the session so users can recognise their devices; trimmed to the column sizes
function clientInfo(req) {
  return {
    userAgent: req.get('user-agent')?.slice(0, 512) ?? null,
    ipAddress: req.ip?.slice(0, 64) ?? null,
  };
}

export async function register(req, res, next) {
  try {
    const result = await authService.register(req.body);
    res.status(201).json({
      success: true,
      data: result,
      message: 'Registration successful. Please verify your email.',
    });
  } catch (error) {
    next(error);
  }
}

export async function login(req, res, next) {
  try {
    const result = await authService.login(req.body, clientInfo(req));
    res.status(200).json({
      success: true,
      data: result,
      message: 'Login successful',
    });
  } catch (error) {
    next(error);
  }
}

export async function refresh(req, res, next) {
  try {
    const result = await authService.refresh(req.body, clientInfo(req));
    res.status(200).json({
      success: true,
      data: result,
      message: 'Token refreshed successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function logout(req, res, next) {
  try {
    const result = await authService.logout(req.body);
    res.status(200).json({
      success: true,
      data: result,
      message: 'Logout successful',
    });
  } catch (error) {
    next(error);
  }
}

export async function forgotPassword(req, res, next) {
  try {
    const result = await authService.forgotPassword(req.body);
    res.status(200).json({
      success: true,
      data: result,
      message: 'If the email exists, a reset link has been sent',
    });
  } catch (error) {
    next(error);
  }
}

export async function resetPassword(req, res, next) {
  try {
    const result = await authService.resetPassword(req.body);
    res.status(200).json({
      success: true,
      data: result,
      message: 'Password has been reset successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function verifyEmail(req, res, next) {
  try {
    const result = await authService.verifyEmail(req.body);
    res.status(200).json({
      success: true,
      data: result,
      message: 'Email verified successfully',
    });
  } catch (error) {
    next(error);
  }
}

export async function me(req, res, next) {
  try {
    const userId = req.context.userId;
    const tenantId = req.context.tenantId;
    const scope = req.context.scope || 'tenant';
    
    if (!userId || !tenantId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required', details: null },
        requestId: req.id,
      });
    }

    const user = scope === 'support' ? await supportService.describe(req.context) : await authService.getMe(userId, tenantId, scope);
    res.status(200).json({
      success: true,
      data: user,
      message: 'User retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}
// ── Phase 28: account self-service ───────────────────────────────────

export async function changePassword(req, res, next) {
  try {
    const result = await authService.changePassword(req.context.userId, req.context.sessionId, req.body);
    res.status(200).json({ success: true, data: result, message: 'Password changed. Other sessions have been signed out.' });
  } catch (error) {
    next(error);
  }
}

export async function updateMe(req, res, next) {
  try {
    const user = await authService.updateMe(req.context.userId, req.context.tenantId, req.body);
    res.status(200).json({ success: true, data: user, message: 'Profile updated successfully' });
  } catch (error) {
    next(error);
  }
}

export async function resendVerification(req, res, next) {
  try {
    const result = await authService.resendVerification(req.context.userId, req.context.tenantId);
    res.status(200).json({ success: true, data: result, message: 'Verification email sent' });
  } catch (error) {
    next(error);
  }
}

export async function listSessions(req, res, next) {
  try {
    const { userId, tenantId, sessionId } = req.context;
    const sessions = await authService.listSessions(userId, tenantId, sessionId);
    res.status(200).json({ success: true, data: sessions, message: 'Sessions retrieved successfully' });
  } catch (error) {
    next(error);
  }
}

export async function revokeSession(req, res, next) {
  try {
    const result = await authService.revokeSession(req.context.userId, req.context.tenantId, req.params.sessionId);
    res.status(200).json({ success: true, data: result, message: 'Session revoked' });
  } catch (error) {
    next(error);
  }
}

export async function logoutAll(req, res, next) {
  try {
    const result = await authService.logoutAll(req.context.userId);
    res.status(200).json({ success: true, data: result, message: 'Signed out of all sessions' });
  } catch (error) {
    next(error);
  }
}
