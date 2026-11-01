import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export const signToken = (userId) =>
  jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

// Returns the user id, or null if the token is missing, forged or expired.
export function verifyToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, config.jwtSecret).sub;
  } catch {
    return null;
  }
}
