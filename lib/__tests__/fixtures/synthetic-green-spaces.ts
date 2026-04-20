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

  // NYC N. Williamsburg / Greenpoint border — matches the user's Build 23
  // screenshot start (N 4th & Wythe area). Parks include McCarren (north),
  // Bushwick Inlet (NW waterfront), Marsha P. Johnson State Park (further
  // west on the waterfront — note this is a thin riverfront strip with only
  // one road in/out, exactly the geometry that triggers stub-detour spurs).
  '40.718,-73.961': [
    { point: { lat: 40.7203, lng: -73.9525 }, tier: 1, kind: 'park',       name: 'McCarren Park',             areaSize: 0.14  },
    { point: { lat: 40.7220, lng: -73.9613 }, tier: 1, kind: 'park',       name: 'Bushwick Inlet Park',       areaSize: 0.045 },
    { point: { lat: 40.7240, lng: -73.9617 }, tier: 1, kind: 'park',       name: 'East River State Park',     areaSize: 0.055 },
    { point: { lat: 40.7280, lng: -73.9655 }, tier: 1, kind: 'park',       name: 'Marsha P. Johnson State Park', areaSize: 0.022 },
    { point: { lat: 40.7144, lng: -73.9685 }, tier: 1, kind: 'waterfront', name: 'Domino Park',               areaSize: 0.024 },
    { point: { lat: 40.7295, lng: -73.9590 }, tier: 1, kind: 'waterfront', name: 'WNYC Transmitter Park',     areaSize: 0.012 },
    { point: { lat: 40.7325, lng: -73.9590 }, tier: 1, kind: 'park',       name: 'Msgr. McGolrick Park',      areaSize: 0.025 },
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

  // NYC Tribeca / FiDi — water on three sides (Hudson W, East River E, harbor S).
  '40.717,-74.008': [
    { point: { lat: 40.7115, lng: -74.0150 }, tier: 1, kind: 'park',       name: 'Battery Park City',         areaSize: 0.12  },
    { point: { lat: 40.7039, lng: -74.0170 }, tier: 1, kind: 'park',       name: 'The Battery',               areaSize: 0.10  },
    { point: { lat: 40.7196, lng: -74.0090 }, tier: 1, kind: 'park',       name: 'Washington Market Park',    areaSize: 0.012 },
    { point: { lat: 40.7172, lng: -74.0140 }, tier: 1, kind: 'waterfront', name: 'Hudson River Greenway',     areaSize: 0     },
    { point: { lat: 40.7090, lng: -74.0035 }, tier: 1, kind: 'park',       name: 'City Hall Park',            areaSize: 0.025 },
    { point: { lat: 40.7234, lng: -74.0090 }, tier: 2, kind: 'park',       name: 'Duarte Square',             areaSize: 0.005 },
    { point: { lat: 40.7188, lng: -74.0050 }, tier: 2, kind: 'park',       name: 'Tribeca Park',              areaSize: 0.004 },
  ],

  // NYC Upper West Side — Central Park to the east, Riverside Park along Hudson.
  '40.785,-73.975': [
    { point: { lat: 40.7829, lng: -73.9654 }, tier: 1, kind: 'park',       name: 'Central Park',              areaSize: 3.41  },
    { point: { lat: 40.7910, lng: -73.9760 }, tier: 1, kind: 'park',       name: 'Riverside Park',            areaSize: 1.30  },
    { point: { lat: 40.7912, lng: -73.9737 }, tier: 1, kind: 'park',       name: 'Joan of Arc Park',          areaSize: 0.005 },
    { point: { lat: 40.7787, lng: -73.9853 }, tier: 1, kind: 'waterfront', name: 'Hudson River Greenway',     areaSize: 0     },
    { point: { lat: 40.7920, lng: -73.9670 }, tier: 1, kind: 'park',       name: 'Theodore Roosevelt Park',   areaSize: 0.075 },
  ],

  // NYC Upper East Side — Central Park west, East River + Carl Schurz east.
  '40.777,-73.958': [
    { point: { lat: 40.7794, lng: -73.9632 }, tier: 1, kind: 'park',       name: 'Central Park',              areaSize: 3.41  },
    { point: { lat: 40.7773, lng: -73.9442 }, tier: 1, kind: 'park',       name: 'Carl Schurz Park',          areaSize: 0.060 },
    { point: { lat: 40.7706, lng: -73.9512 }, tier: 1, kind: 'park',       name: 'John Jay Park',             areaSize: 0.014 },
    { point: { lat: 40.7773, lng: -73.9437 }, tier: 1, kind: 'waterfront', name: 'East River Esplanade',      areaSize: 0     },
    { point: { lat: 40.7784, lng: -73.9618 }, tier: 1, kind: 'park',       name: 'Engineers Gate',            areaSize: 0     },
  ],

  // NYC Chelsea — Hudson River Park to west, High Line cuts through, Madison Sq south.
  '40.747,-74.002': [
    { point: { lat: 40.7480, lng: -74.0086 }, tier: 1, kind: 'waterfront', name: 'Hudson River Park',         areaSize: 0     },
    { point: { lat: 40.7480, lng: -74.0048 }, tier: 1, kind: 'route',      name: 'High Line',                 areaSize: 0     },
    { point: { lat: 40.7423, lng: -73.9881 }, tier: 1, kind: 'park',       name: 'Madison Square Park',       areaSize: 0.027 },
    { point: { lat: 40.7505, lng: -74.0020 }, tier: 1, kind: 'park',       name: 'Chelsea Park',              areaSize: 0.012 },
    { point: { lat: 40.7398, lng: -73.9960 }, tier: 1, kind: 'park',       name: 'Union Square Park',         areaSize: 0.024 },
    { point: { lat: 40.7536, lng: -74.0040 }, tier: 2, kind: 'park',       name: 'Chelsea Waterside Park',    areaSize: 0.014 },
  ],

  // NYC Brooklyn Heights — narrow grid + Brooklyn Bridge Park along East River.
  '40.696,-73.994': [
    { point: { lat: 40.7008, lng: -73.9966 }, tier: 1, kind: 'waterfront', name: 'Brooklyn Bridge Park',      areaSize: 0.34  },
    { point: { lat: 40.6952, lng: -73.9937 }, tier: 1, kind: 'park',       name: 'Brooklyn Heights Promenade', areaSize: 0.014 },
    { point: { lat: 40.6920, lng: -73.9906 }, tier: 1, kind: 'park',       name: 'Cadman Plaza Park',         areaSize: 0.040 },
    { point: { lat: 40.6900, lng: -73.9810 }, tier: 1, kind: 'park',       name: 'Fort Greene Park',          areaSize: 0.120 },
    { point: { lat: 40.6905, lng: -73.9871 }, tier: 2, kind: 'park',       name: 'Walt Whitman Park',         areaSize: 0.008 },
  ],

  // NYC DUMBO — pocket between bridges, water-bounded.
  '40.703,-73.989': [
    { point: { lat: 40.7027, lng: -73.9922 }, tier: 1, kind: 'waterfront', name: 'Brooklyn Bridge Park',      areaSize: 0.34  },
    { point: { lat: 40.7019, lng: -73.9890 }, tier: 1, kind: 'park',       name: 'Pearl Street Triangle',     areaSize: 0.001 },
    { point: { lat: 40.7045, lng: -73.9870 }, tier: 1, kind: 'park',       name: 'Main Street Park',          areaSize: 0.008 },
    { point: { lat: 40.6972, lng: -73.9858 }, tier: 1, kind: 'park',       name: 'Cadman Plaza Park',         areaSize: 0.040 },
    { point: { lat: 40.7010, lng: -73.9933 }, tier: 1, kind: 'waterfront', name: 'Empire Fulton Ferry',       areaSize: 0     },
  ],
};

/** Lookup by fixture center coords. Returns undefined if no synthetic data exists. */
export function syntheticForCenter(lat: number, lng: number): GreenSpace[] | undefined {
  return SYNTHETIC_GREEN_SPACES[`${lat.toFixed(3)},${lng.toFixed(3)}`];
}
