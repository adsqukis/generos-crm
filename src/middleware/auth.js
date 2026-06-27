import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Verify JWT token from Authorization header
 */
export function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, email, role }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Restrict access to specific roles
 * Usage: requireRole('admin', 'marketing_manager')
 */
export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        required: allowedRoles,
        yourRole: req.user?.role,
      });
    }
    next();
  };
}

/**
 * Verify job secret key for external cron triggers
 */
export function authenticateJob(req, res, next) {
  const jobKey = req.headers['x-job-key'];
  if (jobKey !== process.env.JOB_SECRET_KEY) {
    return res.status(401).json({ error: 'Invalid job key' });
  }
  next();
}
