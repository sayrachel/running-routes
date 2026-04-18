/**
 * Curated set of parks/greenways well-known to the running community.
 *
 * The base scoring already rewards size and named status, but this list
 * captures something the geometry can't: that *McCarren Park* is a destination
 * for runners (track + open meadows) while *Tompkins Square Park* is a
 * neighborhood square with comparable area but no running culture.
 *
 * Match is case-insensitive on the OSM `name` tag. Aliases handle common
 * naming variants (e.g. "Riverside Park" vs "Riverside Park, Manhattan").
 *
 * To extend: add parks you'd recommend to a runner, not parks that merely
 * exist. Maintain regional spread so we don't bias toward any one city.
 */

const POPULAR_PARK_NAMES = new Set([
  // --- New York ---
  'central park',
  'prospect park',
  'mccarren park',
  'riverside park',
  'carl schurz park',
  'east river park',
  'east river greenway',
  'hudson river greenway',
  'hudson river park',
  'brooklyn bridge park',
  'brooklyn heights promenade',
  'domino park',
  'bushwick inlet park',
  'fort greene park',
  'astoria park',
  'flushing meadows corona park',
  'van cortlandt park',

  // --- Boston ---
  'boston common',
  'public garden',
  'charles river esplanade',
  'commonwealth avenue mall',
  'arnold arboretum',
  'franklin park',
  'jamaica pond',

  // --- San Francisco ---
  'golden gate park',
  'embarcadero promenade',
  'aquatic park',
  'crissy field',
  'lands end',
  'presidio',
  'mission bay park',
  'mission creek park',

  // --- Chicago ---
  'lakefront trail',
  'grant park',
  'millennium park',
  'maggie daley park',
  'lincoln park',
  'washington park',
  'jackson park',
  'humboldt park',
  'the 606',

  // --- Los Angeles ---
  'griffith park',
  'venice boardwalk',
  'venice beach',
  'marina del rey promenade',
  'silver lake reservoir',
  'echo park lake',
  'kenneth hahn state recreation area',
  'will rogers state historic park',

  // --- Washington DC ---
  'national mall',
  'rock creek park',
  'east potomac park',
  'georgetown waterfront park',
  'mount vernon trail',

  // --- Seattle ---
  'green lake park',
  'discovery park',
  'gas works park',
  'seward park',  // (Seattle's Seward Park, distinct from NYC's smaller Seward Park)
  'magnuson park',

  // --- Portland ---
  'forest park',
  'waterfront park',
  'mount tabor park',

  // --- Other major cities ---
  'piedmont park',         // Atlanta
  'centennial olympic park', // Atlanta
  'audubon park',           // New Orleans
  'memorial park',          // Houston
  'town lake trail',        // Austin
  'lady bird lake',         // Austin
  'balboa park',            // San Diego
  'cherry creek trail',     // Denver
  'wash park',              // Denver
  'minnehaha park',         // Minneapolis
  'lake harriet',           // Minneapolis
  'mill ends park',         // Portland-area
  'liberty state park',     // NJ
]);

/**
 * Returns true if the given OSM park name is on the curated runner-popular list.
 * Case-insensitive; trims whitespace; strips common parenthetical suffixes
 * like "(Manhattan)" so name variants still match.
 */
export function isPopularRunningPark(name: string | null | undefined): boolean {
  if (!name) return false;
  const normalized = name
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, ' ')   // strip "(borough)" suffixes
    .replace(/\s*,\s*[a-z\s]+$/i, '')   // strip ", manhattan" / ", brooklyn"
    .trim();
  return POPULAR_PARK_NAMES.has(normalized);
}
