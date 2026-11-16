-- Running profile for the run-routes app (CLAUDE.md #62).
--
-- Derived from OSRM's foot.lua (osrm-backend 26.4.1, api_version 2). The
-- public router.project-osrm.org only serves the car profile, and stock
-- foot profiles make poor running routes in NYC, so the app needs its own
-- server with this profile. Changes vs foot.lua:
--
-- 1. Bike paths are runnable. highway=cycleway and highway=bridleway route
--    unless explicitly foot=no (US multi-use greenways are routinely tagged
--    cycleway with no foot=* tag; stock foot.lua drops them).
-- 2. Street centerlines over separately mapped sidewalks. foot.lua 26.x
--    blocks any carriageway tagged sidewalk=separate, which in NYC leaves
--    ~85% of a route on unnamed footway=sidewalk ways: no street names for
--    turn-by-turn, jogs at every crosswalk, and out-and-back on opposite
--    sidewalks hides retrace from the app's detectors. Here carriageways
--    stay routable and sidewalks/crossings cost a bit more, so routes follow
--    named streets and only use sidewalks where they add connectivity.
-- 3. Runner preferences (weight only; durations stay at walking speed):
--    greenways and car-free park drives > quiet streets > busy streets >
--    alleys/parking aisles > steps. Named walkways are neutral and
--    unnamed ones slightly discouraged so routes aren't pulled through
--    housing-complex interiors (#35).
-- 4. Turn cost. foot.lua has no turn penalty, so equal-length grid
--    staircases are tie-broken arbitrarily and routes zigzag; a small
--    angle-based weight picks the fewest turns.
-- 5. Only real ways. foot.lua's speed handler makes ANY way with a
--    whitelisted access tag walkable (a foot=yes ferry route became a
--    1.5km "walk" across the Hudson; also platforms, area outlines). Here
--    a way must have a runnable highway type (or be a pier / running
--    track). No ferries, platforms, parking lots or customers-only ways;
--    tunnels and indoor passages only as a last resort.
-- 6. Classes, so the app can see what each step runs on:
--    greenway, path, sidewalk, steps, busy, service.

api_version = 2

Set = require('lib/set')
Sequence = require('lib/sequence')
Handlers = require("lib/way_handlers")
find_access_tag = require("lib/access").find_access_tag

-- Weight multipliers (rate = speed * preference; higher = preferred).
local PREF = {
  greenway      = 1.20, -- cycleways, bike-allowed paths, car-free drives
  pedestrian    = 1.05, -- pedestrian streets / plazas
  living_street = 1.05,
  path          = 1.00, -- named footways/paths (esplanades, promenades)
  path_unnamed  = 0.90, -- unnamed footways/paths/tracks
  street        = 1.00, -- residential, unclassified, road
  tertiary      = 0.95,
  secondary     = 0.90,
  primary       = 0.85,
  service       = 0.90,
  service_minor = 0.75, -- alley, driveway, parking aisle, drive-through
  sidewalk      = 0.80, -- footway=sidewalk/crossing: prefer the named street
  steps         = 0.60,
  tunnel        = 0.50, -- pedestrian tunnels, indoor/underground passages
  other         = 0.80,
}

local ROAD_CLASSES = Set {
  'trunk', 'trunk_link',
  'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'unclassified', 'residential',
  'living_street', 'road', 'service'
}
local PUBLIC_ROADS = Set {
  'primary', 'secondary', 'tertiary', 'unclassified', 'residential',
  'living_street', 'road'
}
local MINOR_SERVICE = Set { 'alley', 'driveway', 'parking_aisle', 'drive-through' }
local RUNNABLE_HIGHWAY = Set {
  'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'unclassified', 'residential', 'road',
  'living_street', 'service', 'track', 'path', 'steps', 'pedestrian',
  'footway', 'pier', 'cycleway', 'bridleway'
}
-- trunk roads only where pedestrians are explicitly allowed
local TRUNK = Set { 'trunk', 'trunk_link' }
local BIKE_OK = Set { 'yes', 'designated', 'permissive' }
local FOOT_OK = Set { 'yes', 'designated', 'permissive', 'official' }

function setup()
  local walking_speed = 5
  return {
    properties = {
      weight_name                   = 'running',
      max_speed_for_map_matching    = 40/3.6, -- kmph -> m/s
      call_tagless_node_function    = false,
      traffic_signal_penalty        = 2,
      u_turn_penalty                = 2,
      continue_straight_at_waypoint = false,
      use_turn_restrictions         = false,
      -- preserve short road crossings for pedestrian safety analysis
      max_collapse_distance         = 10,
    },

    -- weight-only cost (seconds) of a 90-degree turn; see process_turn
    turn_penalty            = 4,

    default_mode            = mode.walking,
    default_speed           = walking_speed,
    oneway_handling         = 'specific',     -- respect 'oneway:foot' but not 'oneway'

    barrier_blacklist = Set {
      'yes',
      'wall',
      'fence'
    },

    access_tag_whitelist = Set {
      'yes',
      'foot',
      'permissive',
      'designated'
    },

    access_tag_blacklist = Set {
      'no',
      'agricultural',
      'forestry',
      'private',
      'delivery',
      'use_sidepath',
      'customers',
      'permit',
    },

    restricted_access_tag_list = Set { },

    restricted_highway_whitelist = Set { },

    construction_whitelist = Set {},

    access_tags_hierarchy = Sequence {
      'foot',
      'access'
    },

    service_access_tag_blacklist = Set { },

    restrictions = Sequence {
      'foot'
    },

    suffix_list = Set {
      'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW', 'North', 'South', 'West', 'East'
    },

    avoid = Set {
      'impassable',
      'proposed',
      'motorroad'
    },

    classes = Sequence {
      'greenway', 'path', 'sidewalk', 'steps', 'busy', 'service'
    },

    excludable = Sequence { },

    speeds = Sequence {
      highway = {
        primary         = walking_speed,
        primary_link    = walking_speed,
        secondary       = walking_speed,
        secondary_link  = walking_speed,
        tertiary        = walking_speed,
        tertiary_link   = walking_speed,
        unclassified    = walking_speed,
        residential     = walking_speed,
        road            = walking_speed,
        living_street   = walking_speed,
        service         = walking_speed,
        track           = walking_speed,
        path            = walking_speed,
        steps           = walking_speed,
        pedestrian      = walking_speed,
        footway         = walking_speed,
        pier            = walking_speed,
        cycleway        = walking_speed,
        bridleway       = walking_speed,
        trunk           = walking_speed,
        trunk_link      = walking_speed,
      },

      man_made = {
        pier            = walking_speed
      },

      leisure = {
        track           = walking_speed
      }
    },

    -- no ferries
    route_speeds = { },

    bridge_speeds = {
    },

    surface_speeds = {
      fine_gravel =   walking_speed*0.75,
      gravel =        walking_speed*0.75,
      pebblestone =   walking_speed*0.75,
      mud =           walking_speed*0.5,
      sand =          walking_speed*0.5
    },

    tracktype_speeds = {
    },

    smoothness_speeds = {
    }
  }
end

function process_node(profile, node, result)
  -- parse access and barrier tags
  local access = find_access_tag(node, profile.access_tags_hierarchy)
  if access then
    if profile.access_tag_blacklist[access] then
      result.barrier = true
    end
  else
    local barrier = node:get_value_by_key("barrier")
    if barrier then
      --  make an exception for rising bollard barriers
      local bollard = node:get_value_by_key("bollard")
      local rising_bollard = bollard and "rising" == bollard

      -- make an exception for fence with sensory=audible/audio (virtual livestock fences)
      local sensory = node:get_value_by_key("sensory")
      local audible_fence = barrier == "fence" and sensory and (sensory == "audible" or sensory == "audio")

      if profile.barrier_blacklist[barrier] and not rising_bollard and not audible_fence then
        result.barrier = true
      end
    end
  end

  -- check if node is a traffic light
  local tag = node:get_value_by_key("highway")
  if "traffic_signals" == tag then
    result.traffic_lights = true
  end
end

-- Drop everything that isn't a runnable way type (see header, point 5).
local function runnable_way(profile, way, result, data)
  if data.route == 'ferry' then
    return false
  end
  local hw = data.highway
  if hw then
    if RUNNABLE_HIGHWAY[hw] then
      return
    end
    if TRUNK[hw] then
      local foot = way:get_value_by_key('foot')
      if foot and FOOT_OK[foot] then
        return
      end
    end
    return false
  end
  if data.man_made == 'pier' or data.leisure == 'track' then
    return
  end
  return false
end

-- Classify a routable way for runner preference + response classes.
-- Returns (preference, class or nil).
local function classify(way, data)
  local hw = data.highway
  local footway = way:get_value_by_key('footway')

  local tunnel = way:get_value_by_key('tunnel')
  local indoor = way:get_value_by_key('indoor')
  local location = way:get_value_by_key('location')
  if (tunnel and tunnel ~= 'no' and tunnel ~= 'building_passage')
      or (indoor and indoor ~= 'no') or location == 'underground' then
    return PREF.tunnel, nil
  end

  if footway == 'sidewalk' or footway == 'crossing' then
    return PREF.sidewalk, 'sidewalk'
  end
  if hw == 'steps' then
    return PREF.steps, 'steps'
  end

  local bicycle = way:get_value_by_key('bicycle')
  local bike_ok = bicycle and BIKE_OK[bicycle]
  if hw == 'cycleway' then
    -- Only shared-use paths (foot explicitly allowed) get the greenway
    -- bonus. Untagged cycleways are runnable but neutral: in NYC they
    -- include protected on-street lanes (Broadway, Pike St, Tillary St)
    -- that shouldn't pull routes onto their avenue.
    local foot = way:get_value_by_key('foot')
    if foot and FOOT_OK[foot] then
      return PREF.greenway, 'greenway'
    end
    return PREF.street, 'greenway'
  end
  if (hw == 'path' or hw == 'footway' or hw == 'bridleway' or hw == 'pedestrian') and bike_ok then
    -- shared-use paths; also Central/Prospect Park drives, which are
    -- highway=pedestrian + bicycle=designated
    return PREF.greenway, 'greenway'
  end
  if hw == 'path' or hw == 'footway' or hw == 'bridleway' or hw == 'track'
      or data.leisure == 'track' or data.man_made == 'pier' or hw == 'pier' then
    -- Named walkways (esplanades, promenades, bridge footpaths) are
    -- neutral; unnamed ones are mostly housing-complex and campus
    -- interiors, so a cut-through has to save >10% to win (#35).
    local name = way:get_value_by_key('name')
    if name and name ~= '' then
      return PREF.path, 'path'
    end
    return PREF.path_unnamed, 'path'
  end
  if hw == 'pedestrian' then
    return PREF.pedestrian, 'path'
  end

  if hw and ROAD_CLASSES[hw] then
    -- car-free drives (park loops closed to traffic) behave like greenways
    local mv = way:get_value_by_key('motor_vehicle')
    local mc = way:get_value_by_key('motorcar')
    local base = hw:gsub('_link$', '')
    if ((mv == 'no' or mc == 'no') and PUBLIC_ROADS[base])
        or ((mv == 'no' or mv == 'private') and bike_ok) then
      return PREF.greenway, 'greenway'
    end
    if hw == 'service' then
      local service = way:get_value_by_key('service')
      if service and MINOR_SERVICE[service] then
        return PREF.service_minor, 'service'
      end
      return PREF.service, 'service'
    end
    if base == 'primary' or base == 'trunk' then return PREF.primary, 'busy' end
    if base == 'secondary' then return PREF.secondary, 'busy' end
    if base == 'tertiary' then return PREF.tertiary, nil end
    if hw == 'living_street' then return PREF.living_street, nil end
    return PREF.street, nil
  end

  return PREF.other, nil
end

-- Convert the walking-speed durations into the 'running' weight and tag
-- the way's class. Runs after the speed/surface handlers.
local function runner_weights(profile, way, result, data)
  local pref, class = classify(way, data)
  if result.forward_speed > 0 then
    result.forward_rate = result.forward_speed / 3.6 * pref
  end
  if result.backward_speed > 0 then
    result.backward_rate = result.backward_speed / 3.6 * pref
  end
  if result.duration > 0 then
    result.weight = result.duration / pref
  end
  if class then
    result.forward_classes[class] = true
    result.backward_classes[class] = true
  end
end

function process_way(profile, way, result)
  local data = {
    -- prefetch tags
    highway = way:get_value_by_key('highway'),
    bridge = way:get_value_by_key('bridge'),
    route = way:get_value_by_key('route'),
    leisure = way:get_value_by_key('leisure'),
    man_made = way:get_value_by_key('man_made'),
    railway = way:get_value_by_key('railway'),
    platform = way:get_value_by_key('platform'),
    amenity = way:get_value_by_key('amenity'),
    public_transport = way:get_value_by_key('public_transport')
  }

  if next(data) == nil then     -- is the data table empty?
    return
  end

  local handlers = Sequence {
    runnable_way,
    WayHandlers.default_mode,
    WayHandlers.blocked_ways,
    WayHandlers.access,
    -- (foot.lua's handle_sidewalk_separate intentionally omitted, see header)
    WayHandlers.oneway,
    WayHandlers.destinations,
    WayHandlers.ferries,
    WayHandlers.movables,
    WayHandlers.speed,
    WayHandlers.surface,
    WayHandlers.conveying,
    WayHandlers.classification,
    WayHandlers.roundabouts,
    WayHandlers.startpoint,
    WayHandlers.names,
    WayHandlers.weights,
    runner_weights
  }

  WayHandlers.run(profile, way, result, data, handlers)
end

function process_turn(profile, turn)
  turn.duration = 0.

  if turn.direction_modifier == direction_modifier.u_turn then
    turn.duration = turn.duration + profile.properties.u_turn_penalty
  end

  if turn.has_traffic_light then
    turn.duration = turn.duration + profile.properties.traffic_signal_penalty
  end

  -- Weight-only turn cost, quadratic in angle and capped at 2x the 90-degree
  -- cost: ~0 for gentle bends, turn_penalty for a right angle. turn.angle is
  -- 0 for straight on, +/-180 for a U-turn.
  local a = math.abs(turn.angle) / 90
  turn.weight = turn.duration + profile.turn_penalty * math.min(2, a * a)
end

return {
  setup = setup,
  process_way =  process_way,
  process_node = process_node,
  process_turn = process_turn
}
