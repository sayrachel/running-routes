export interface RoutePoint {
  lat: number
  lng: number
}

export interface GeneratedRoute {
  id: string
  name: string
  points: RoutePoint[]
  distance: number // in km
  estimatedTime: number // in minutes
  elevationGain: number // in meters
  terrain: string
  difficulty: "easy" | "moderate" | "hard"
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

function toDeg(rad: number): number {
  return (rad * 180) / Math.PI
}

function haversineDistance(p1: RoutePoint, p2: RoutePoint): number {
  const R = 6371 // Earth radius in km
  const dLat = toRad(p2.lat - p1.lat)
  const dLng = toRad(p2.lng - p1.lng)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(p1.lat)) *
      Math.cos(toRad(p2.lat)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

function destinationPoint(
  origin: RoutePoint,
  bearing: number,
  distanceKm: number
): RoutePoint {
  const R = 6371
  const d = distanceKm / R
  const brng = toRad(bearing)
  const lat1 = toRad(origin.lat)
  const lng1 = toRad(origin.lng)

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
  )
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    )

  return { lat: toDeg(lat2), lng: toDeg(lng2) }
}

function generateLoopRoute(
  start: RoutePoint,
  targetDistanceKm: number,
  seed: number
): RoutePoint[] {
  const points: RoutePoint[] = [start]
  const numWaypoints = 6 + Math.floor(seed * 4) // 6-9 waypoints
  const radius = targetDistanceKm / (2 * Math.PI) // approximate radius for a loop
  const startBearing = seed * 360

  for (let i = 1; i <= numWaypoints; i++) {
    const angle = startBearing + (360 / numWaypoints) * i
    const jitter = (Math.sin(seed * 1000 + i * 137.5) * 0.4 + 0.8) * radius
    const bearingJitter = Math.sin(seed * 2000 + i * 97.3) * 15
    const point = destinationPoint(start, angle + bearingJitter, jitter)
    points.push(point)
  }

  points.push(start) // close the loop
  return points
}

function generateOutAndBackRoute(
  start: RoutePoint,
  targetDistanceKm: number,
  seed: number
): RoutePoint[] {
  const outPoints: RoutePoint[] = [start]
  const halfDistance = targetDistanceKm / 2
  const numWaypoints = 4 + Math.floor(seed * 3)
  const mainBearing = seed * 360
  const segmentDist = halfDistance / numWaypoints

  for (let i = 1; i <= numWaypoints; i++) {
    const bearingJitter = Math.sin(seed * 3000 + i * 47.7) * 20
    const distJitter = segmentDist * (0.8 + Math.sin(seed * 4000 + i * 63.1) * 0.3)
    const prevPoint = outPoints[outPoints.length - 1]
    const point = destinationPoint(prevPoint, mainBearing + bearingJitter, distJitter)
    outPoints.push(point)
  }

  const backPoints = [...outPoints].reverse().slice(1).map((p, i) => ({
    lat: p.lat + Math.sin(seed * 5000 + i * 83.9) * 0.0005,
    lng: p.lng + Math.cos(seed * 6000 + i * 91.3) * 0.0005,
  }))

  return [...outPoints, ...backPoints]
}

export interface RoutePreferences {
  lowTraffic: boolean
}

const routeNamesQuiet = [
  "Backstreet Run",
  "Quiet Lanes",
  "Residential Circuit",
  "Sidestreet Shuffle",
  "Neighborhood Loop",
  "Peaceful Path",
]

const routeNamesDefault = [
  "Downtown Explorer",
  "City Loop",
  "Urban Circuit",
  "Coastal Breeze Route",
  "Bridge Connector",
  "Meadow Circuit",
]

function pickRouteName(prefs: RoutePreferences, index: number, startLat: number): string {
  const names = prefs.lowTraffic ? routeNamesQuiet : routeNamesDefault
  const idx = Math.abs((index + Math.floor(startLat * 10)) % names.length)
  return names[idx]
}

function generatePointToPointRoute(
  start: RoutePoint,
  end: RoutePoint,
  seed: number
): RoutePoint[] {
  const points: RoutePoint[] = [start]
  const numWaypoints = 4 + Math.floor(seed * 4)

  for (let i = 1; i <= numWaypoints; i++) {
    const t = i / (numWaypoints + 1)
    const baseLat = start.lat + (end.lat - start.lat) * t
    const baseLng = start.lng + (end.lng - start.lng) * t
    // Perpendicular offset for variety
    const dLat = end.lat - start.lat
    const dLng = end.lng - start.lng
    const perpLat = -dLng
    const perpLng = dLat
    const offset = Math.sin(seed * 7000 + i * 123.7) * 0.15
    points.push({
      lat: baseLat + perpLat * offset,
      lng: baseLng + perpLng * offset,
    })
  }

  points.push(end)
  return points
}

export function generateRoutes(
  start: RoutePoint,
  targetDistanceKm: number,
  routeType: "loop" | "out-and-back" | "any",
  count: number = 3,
  prefs: RoutePreferences = { lowTraffic: false },
  end?: RoutePoint | null
): GeneratedRoute[] {
  const routes: GeneratedRoute[] = []

  for (let i = 0; i < count; i++) {
    const seed = (i + 1) * 0.31 + Math.sin(start.lat * 100 + i) * 0.1

    const isPointToPoint = routeType === "out-and-back" && end
    const isLoop =
      routeType === "loop" ||
      (routeType === "any" && i % 2 === 0)

    const points = isPointToPoint
      ? generatePointToPointRoute(start, end, seed)
      : isLoop
        ? generateLoopRoute(start, targetDistanceKm, seed)
        : generateOutAndBackRoute(start, targetDistanceKm, seed)

    // Calculate actual distance
    let totalDistance = 0
    for (let j = 1; j < points.length; j++) {
      totalDistance += haversineDistance(points[j - 1], points[j])
    }

    // Scale points to match target distance
    const scale = targetDistanceKm / totalDistance
    const scaledPoints = points.map((p, idx) => {
      if (idx === 0) return p
      return {
        lat: start.lat + (p.lat - start.lat) * scale,
        lng: start.lng + (p.lng - start.lng) * scale,
      }
    })

    // Recalculate distance after scaling
    let actualDistance = 0
    for (let j = 1; j < scaledPoints.length; j++) {
      actualDistance += haversineDistance(scaledPoints[j - 1], scaledPoints[j])
    }

    const pace = 5 + seed * 2 // min/km
    const estimatedTime = Math.round(actualDistance * pace)

    // Elevation gain — hardcoded flat defaults
    const baseElevation = 5 + seed * 20 * (actualDistance / 5)
    const elevationGain = Math.round(baseElevation)

    const difficulty: "easy" | "moderate" | "hard" =
      actualDistance < 5 ? "easy" : actualDistance < 10 ? "moderate" : "hard"

    routes.push({
      id: `route-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: pickRouteName(prefs, i, start.lat),
      points: scaledPoints,
      distance: Math.round(actualDistance * 100) / 100,
      estimatedTime,
      elevationGain,
      terrain: isPointToPoint ? "Point to Point" : isLoop ? "Loop" : "Out & Back",
      difficulty,
    })
  }

  return routes
}
