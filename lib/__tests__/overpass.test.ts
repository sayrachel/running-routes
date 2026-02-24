import { getBbox, bboxKey, parseOverpassCount } from '../overpass';

describe('getBbox', () => {
  it('returns buffered bbox for a single point', () => {
    const points = [{ lat: 40.7128, lng: -74.006 }];
    const [south, west, north, east] = getBbox(points);

    // BBOX_BUFFER_DEG = 0.002
    expect(south).toBeCloseTo(40.7128 - 0.002, 10);
    expect(north).toBeCloseTo(40.7128 + 0.002, 10);
    expect(west).toBeCloseTo(-74.006 - 0.002, 10);
    expect(east).toBeCloseTo(-74.006 + 0.002, 10);
  });

  it('spans correctly for multiple points', () => {
    const points = [
      { lat: 40.0, lng: -74.0 },
      { lat: 41.0, lng: -73.0 },
    ];
    const [south, west, north, east] = getBbox(points);

    expect(south).toBeCloseTo(40.0 - 0.002, 10);
    expect(north).toBeCloseTo(41.0 + 0.002, 10);
    expect(west).toBeCloseTo(-74.0 - 0.002, 10);
    expect(east).toBeCloseTo(-73.0 + 0.002, 10);
  });

  it('handles negative coordinates', () => {
    const points = [
      { lat: -33.8688, lng: 151.2093 },
      { lat: -33.8568, lng: 151.2153 },
    ];
    const [south, west, north, east] = getBbox(points);

    expect(south).toBeLessThan(-33.868);
    expect(north).toBeGreaterThan(-33.857);
    expect(west).toBeLessThan(151.210);
    expect(east).toBeGreaterThan(151.215);
  });
});

describe('bboxKey', () => {
  it('rounds to 3 decimal places', () => {
    const bbox: [number, number, number, number] = [40.71234567, -74.00612345, 40.71834567, -74.00012345];
    const key = bboxKey(bbox);
    expect(key).toBe('40.712,-74.006,40.718,-74.000');
  });

  it('produces same key for very close bboxes (cache stability)', () => {
    const bbox1: [number, number, number, number] = [40.71240, -74.00640, 40.71840, -74.00040];
    const bbox2: [number, number, number, number] = [40.71244, -74.00644, 40.71844, -74.00044];
    // These differ in the 5th decimal place, so after rounding to 3 they match
    expect(bboxKey(bbox1)).toBe(bboxKey(bbox2));
  });
});

describe('parseOverpassCount', () => {
  it('parses count from standard count response', () => {
    const data = {
      elements: [{ type: 'count', tags: { total: '42', nodes: '10', ways: '32' } }],
    };
    expect(parseOverpassCount(data)).toBe(42);
  });

  it('returns 0 for empty elements array', () => {
    expect(parseOverpassCount({ elements: [] })).toBe(0);
  });

  it('returns 0 for missing elements', () => {
    expect(parseOverpassCount({})).toBe(0);
  });

  it('falls back to elements.length for non-count response', () => {
    const data = {
      elements: [
        { type: 'node', lat: 40.0, lon: -74.0 },
        { type: 'node', lat: 40.1, lon: -74.1 },
        { type: 'way', id: 123 },
      ],
    };
    expect(parseOverpassCount(data)).toBe(3);
  });

  it('returns 0 for count with invalid total', () => {
    const data = {
      elements: [{ type: 'count', tags: { total: 'abc' } }],
    };
    expect(parseOverpassCount(data)).toBe(0);
  });
});
