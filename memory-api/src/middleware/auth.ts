import { Request, Response, NextFunction } from 'express';
import { JwksClient } from 'jwks-rsa';
import jwt, { JwtPayload } from 'jsonwebtoken';

// Extend Express Request to carry the verified userId and tier downstream
export interface AuthenticatedRequest extends Request {
  userId: string;
  tier: string;
}

if (!process.env.KEYCLOAK_JWKS_URL) {
  throw new Error('KEYCLOAK_JWKS_URL is not set');
}
if (!process.env.KEYCLOAK_ISSUER_URL) {
  throw new Error('KEYCLOAK_ISSUER_URL is not set');
}
if (!process.env.MEMORY_JWT_AUDIENCE) {
  throw new Error('MEMORY_JWT_AUDIENCE is not set');
}

const jwksClient = new JwksClient({
  jwksUri: process.env.KEYCLOAK_JWKS_URL,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 600_000, // 10 minutes
  rateLimit: true,
  jwksRequestsPerMinute: 10,
});

function getSigningKey(kid: string): Promise<string> {
  return new Promise((resolve, reject) => {
    jwksClient.getSigningKey(kid, (err, key) => {
      if (err || !key) {
        reject(err ?? new Error('Signing key not found'));
        return;
      }
      resolve(key.getPublicKey());
    });
  });
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  let decoded: JwtPayload;
  try {
    // Decode without verifying first to extract kid
    const unverified = jwt.decode(token, { complete: true });
    if (!unverified || typeof unverified === 'string' || !unverified.header.kid) {
      res.status(401).json({ error: 'Invalid token format' });
      return;
    }

    const publicKey = await getSigningKey(unverified.header.kid);

    decoded = jwt.verify(token, publicKey, {
      algorithms: ['RS256'],
      issuer: process.env.KEYCLOAK_ISSUER_URL,
      audience: process.env.MEMORY_JWT_AUDIENCE,
    }) as JwtPayload;
  } catch {
    res.status(401).json({ error: 'Token validation failed' });
    return;
  }

  if (!decoded.sub) {
    res.status(401).json({ error: 'Token missing sub claim' });
    return;
  }

  // Attach to request - downstream handlers MUST use these, never trust user-supplied IDs
  (req as AuthenticatedRequest).userId = decoded.sub;
  (req as AuthenticatedRequest).tier = (decoded['tier'] as string) ?? 'guest';

  next();
}
