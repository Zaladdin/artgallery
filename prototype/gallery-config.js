const MIN_ROOM_WIDTH_METRES = 15;
const ROOM_DEPTH_METRES = 4;
const ENTRANCE_VIEWPOINT_OFFSET_METRES = 1.5;

function normalizedArtworkCount(artworkCount) {
  if (!Number.isFinite(artworkCount)) {
    return 0;
  }

  return Math.max(0, Math.ceil(artworkCount));
}

/**
 * Creates a room sized for an even split of the works across both long walls.
 * Each wall keeps a one-metre margin at both ends and reserves two metres per work.
 */
export function createRoomForArtworkCount(artworkCount = 0) {
  const count = normalizedArtworkCount(artworkCount);
  const worksPerLongWall = Math.ceil(count / 2);
  const widthM = Math.max(
    MIN_ROOM_WIDTH_METRES,
    Math.ceil(2 + worksPerLongWall * 2)
  );

  return Object.freeze({
    widthM,
    depthM: ROOM_DEPTH_METRES,
    heightM: 3.4,
    eyeHeightM: 1.6,
    stepM: 1,
    clearanceM: 0.35,
    turnDegrees: 15,
    startX: 0,
    startZ: ROOM_DEPTH_METRES / 2 - ENTRANCE_VIEWPOINT_OFFSET_METRES
  });
}

export const DEFAULT_ROOM = createRoomForArtworkCount();

// Kept for gallery integrations that still import a static room definition.
export const ROOM = DEFAULT_ROOM;
