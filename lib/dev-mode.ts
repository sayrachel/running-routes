// Identities allowed to see in-app debug surfaces (currently: the failure
// diagnostic suffix on error banners). Add an entry per identity you want
// to see them — Apple "hide my email" relays count as separate addresses
// and need to be added explicitly if you sign in that way.
const DEV_EMAILS = new Set<string>([
  'irachelma@gmail.com',
]);

export function isDevUser(email: string | null | undefined): boolean {
  if (!email) return false;
  return DEV_EMAILS.has(email.toLowerCase());
}
