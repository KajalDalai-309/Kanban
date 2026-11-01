import { colorFor, initials } from '../lib/format.js';

export default function Avatar({ user, color, size = 24, ring = false }) {
  if (!user) return null;
  return (
    <span
      className={`avatar ${ring ? 'avatar-ring' : ''}`}
      style={{ background: color ?? colorFor(user.id), width: size, height: size, fontSize: size * 0.42 }}
      title={user.name}
      aria-label={user.name}
    >
      {initials(user.name)}
    </span>
  );
}
