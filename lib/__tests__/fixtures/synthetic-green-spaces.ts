/**
 * Hand-crafted GreenSpace[] approximating real-world OSM data for each
 * harness fixture location. Lets the quality harness exercise the
 * green-space-first algorithm end-to-end when Overpass is unavailable
 * (down, rate-limited, or in CI environments without network).
 *
 * Coordinates are accurate to within a few hundred meters; areaSize
 * values are estimated from real park footprints (km²).
 *
 * Keyed by `${lat.toFixed(3)},${lng.toFixed(3)}` of the fixture center.
 */

import type { GreenSpace } from '../../overpass';

export const SYNTHETIC_GREEN_SPACES: Record<string, GreenSpace[]> = {
  // NYC East Village / NoHo — matches the user's screenshot location, the
  // dense Manhattan grid where block-weaving routes shipped before. Lots
  // of small parks plus distant waterfront on both sides.
  '40.728,-73.992': [
    { point: { lat: 40.7308, lng: -73.9973 }, tier: 1, kind: 'park',       name: 'Washington Square Park',    areaSize: 0.04  },
    { point: { lat: 40.7268, lng: -73.9817 }, tier: 1, kind: 'park',       name: 'Tompkins Square Park',      areaSize: 0.04  },
    { point: { lat: 40.7194, lng: -73.9919 }, tier: 1, kind: 'park',       name: 'Sara D. Roosevelt Park',    areaSize: 0.03  },
    { point: { lat: 40.7186, lng: -73.9778 }, tier: 1, kind: 'park',       name: 'East River Park',           areaSize: 0.32  },
    { point: { lat: 40.7330, lng: -73.9846 }, tier: 1, kind: 'park',       name: 'Stuyvesant Square',         areaSize: 0.018 },
    { point: { lat: 40.7160, lng: -73.9750 }, tier: 1, kind: 'waterfront', name: 'East River Greenway',       areaSize: 0     },
    { point: { lat: 40.7300, lng: -74.0100 }, tier: 1, kind: 'waterfront', name: 'Hudson River Greenway',     areaSize: 0     },
    { point: { lat: 40.7290, lng: -73.9911 }, tier: 2, kind: 'park',       name: 'Cooper Triangle',           areaSize: 0.002 },
  ],

  // NYC Lower East Side — dense Manhattan grid with East River edge.
  '40.715,-73.985': [
    { point: { lat: 40.7186, lng: -73.9778 }, tier: 1, kind: 'park',       name: 'East River Park',           areaSize: 0.32  },
    { point: { lat: 40.7268, lng: -73.9817 }, tier: 1, kind: 'park',       name: 'Tompkins Square Park',      areaSize: 0.04  },
    { point: { lat: 40.7194, lng: -73.9919 }, tier: 1, kind: 'park',       name: 'Sara D. Roosevelt Park',    areaSize: 0.03  },
    { point: { lat: 40.7140, lng: -73.9920 }, tier: 1, kind: 'park',       name: 'Seward Park',               areaSize: 0.012 },
    { point: { lat: 40.7115, lng: -73.9764 }, tier: 1, kind: 'park',       name: 'Corlears Hook Park',        areaSize: 0.025 },
    { point: { lat: 40.7283, lng: -73.9942 }, tier: 1, kind: 'park',       name: 'Washington Square Park',    areaSize: 0.04  },
    { point: { lat: 40.7160, lng: -73.9750 }, tier: 1, kind: 'waterfront', name: 'East River Greenway',       areaSize: 0     },
  ],

  // NYC Columbus Circle — anchored by Central Park + Hudson waterfront.
  '40.768,-73.982': [
    { point: { lat: 40.7829, lng: -73.9654 }, tier: 1, kind: 'park',       name: 'Central Park',              areaSize: 3.41  },
    { point: { lat: 40.7700, lng: -73.9920 }, tier: 1, kind: 'waterfront', name: 'Hudson River Greenway',     areaSize: 0     },
    { point: { lat: 40.7677, lng: -73.9870 }, tier: 2, kind: 'park',       name: "Hell's Kitchen Park",       areaSize: 0.005 },
    { point: { lat: 40.7725, lng: -73.9835 }, tier: 2, kind: 'park',       name: 'Lincoln Center Plaza',      areaSize: 0.012 },
    { point: { lat: 40.7715, lng: -73.9847 }, tier: 2, kind: 'park',       name: 'Damrosch Park',             areaSize: 0.008 },
  ],

  // NYC Williamsburg — Brooklyn waterfront + parks.
  '40.714,-73.961': [
    { point: { lat: 40.7203, lng: -73.9525 }, tier: 1, kind: 'park',       name: 'McCarren Park',             areaSize: 0.14  },
    { point: { lat: 40.7220, lng: -73.9613 }, tier: 1, kind: 'waterfront', name: 'East River State Park',     areaSize: 0.055 },
    { point: { lat: 40.7144, lng: -73.9685 }, tier: 1, kind: 'waterfront', name: 'Domino Park',               areaSize: 0.024 },
    { point: { lat: 40.7240, lng: -73.9617 }, tier: 1, kind: 'park',       name: 'Bushwick Inlet Park',       areaSize: 0.045 },
    { point: { lat: 40.7100, lng: -73.9695 }, tier: 2, kind: 'park',       name: 'Grand Ferry Park',          areaSize: 0.012 },
  ],

  // SF Embarcadero — water on the east; green spaces hug the shoreline + west.
  '37.795,-122.394': [
    { point: { lat: 37.7956, lng: -122.3932 }, tier: 1, kind: 'waterfront', name: 'Embarcadero Promenade',    areaSize: 0     },
    { point: { lat: 37.7950, lng: -122.3963 }, tier: 1, kind: 'park',       name: 'Sue Bierman Park',         areaSize: 0.012 },
    { point: { lat: 37.7847, lng: -122.4030 }, tier: 1, kind: 'park',       name: 'Yerba Buena Gardens',      areaSize: 0.030 },
    { point: { lat: 37.8009, lng: -122.4001 }, tier: 2, kind: 'park',       name: "Levi's Plaza",             areaSize: 0.014 },
    { point: { lat: 37.8030, lng: -122.4180 }, tier: 1, kind: 'waterfront', name: 'Aquatic Park',             areaSize: 0.040 },
    { point: { lat: 37.7919, lng: -122.4180 }, tier: 1, kind: 'park',       name: 'South Park',               areaSize: 0.008 },
  ],

  // Chicago downtown lakefront — Grant/Millennium parks + lakefront trail east.
  '41.886,-87.616': [
    { point: { lat: 41.8770, lng: -87.6213 }, tier: 1, kind: 'park',       name: 'Grant Park',                areaSize: 1.30  },
    { point: { lat: 41.8826, lng: -87.6226 }, tier: 1, kind: 'park',       name: 'Millennium Park',           areaSize: 0.10  },
    { point: { lat: 41.8823, lng: -87.6190 }, tier: 1, kind: 'park',       name: 'Maggie Daley Park',         areaSize: 0.09  },
    { point: { lat: 41.8860, lng: -87.6105 }, tier: 1, kind: 'waterfront', name: 'Lakefront Trail',           areaSize: 0     },
    { point: { lat: 41.8919, lng: -87.6260 }, tier: 2, kind: 'park',       name: 'Pioneer Court',             areaSize: 0.005 },
  ],

  // LA Venice — beach to the west, scattered small parks inland.
  '33.991,-118.464': [
    { point: { lat: 33.9857, lng: -118.4731 }, tier: 1, kind: 'waterfront', name: 'Venice Boardwalk',         areaSize: 0     },
    { point: { lat: 33.9850, lng: -118.4720 }, tier: 1, kind: 'park',       name: 'Venice Beach',             areaSize: 0.18  },
    { point: { lat: 33.9933, lng: -118.4564 }, tier: 1, kind: 'park',       name: 'Penmar Park',              areaSize: 0.030 },
    { point: { lat: 33.9883, lng: -118.4619 }, tier: 2, kind: 'park',       name: 'Oakwood Recreation Center', areaSize: 0.018 },
    { point: { lat: 33.9986, lng: -118.4690 }, tier: 1, kind: 'park',       name: 'Marina Del Rey Promenade', areaSize: 0     },
  ],

  // Boston Back Bay — Common, Public Garden, Esplanade along the Charles.
  '42.350,-71.080': [
    { point: { lat: 42.3554, lng: -71.0656 }, tier: 1, kind: 'park',       name: 'Boston Common',             areaSize: 0.20  },
    { point: { lat: 42.3540, lng: -71.0700 }, tier: 1, kind: 'park',       name: 'Public Garden',             areaSize: 0.10  },
    { point: { lat: 42.3550, lng: -71.0816 }, tier: 1, kind: 'waterfront', name: 'Charles River Esplanade',   areaSize: 0     },
    { point: { lat: 42.3500, lng: -71.0850 }, tier: 1, kind: 'park',       name: 'Commonwealth Avenue Mall',  areaSize: 0.025 },
    { point: { lat: 42.3500, lng: -71.0760 }, tier: 2, kind: 'park',       name: 'Copley Square',             areaSize: 0.012 },
  ],
};

/** Lookup by fixture center coords. Returns undefined if no synthetic data exists. */
export function syntheticForCenter(lat: number, lng: number): GreenSpace[] | undefined {
  return SYNTHETIC_GREEN_SPACES[`${lat.toFixed(3)},${lng.toFixed(3)}`];
}
