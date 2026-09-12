import { AuthService } from './auth.service.js';

const authService = new AuthService();

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
    const result = await authService.login(req.body);
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
    const result = await authService.refresh(req.body);
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
    
    if (!userId || !tenantId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required', details: null },
        requestId: req.id,
      });
    }

    const user = await authService.getMe(userId, tenantId);
    res.status(200).json({
      success: true,
      data: user,
      message: 'User retrieved successfully',
    });
  } catch (error) {
    next(error);
  }
}