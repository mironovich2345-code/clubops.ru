// Single normalization used everywhere an email is hashed, checked for
// uniqueness, or compared (registration, deletion, restoration). Keep this the
// ONE definition so a released email and a new registration agree byte-for-byte.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}
