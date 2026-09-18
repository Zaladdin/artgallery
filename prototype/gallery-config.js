const MIN_ROOM_LENGTH_METRES = 25;
const ROOM_WIDTH_METRES = 8;
const ENTRANCE_VIEWPOINT_OFFSET_METRES = 0.55;
const ARTWORK_SIDE_MARGIN_METRES = 1.3;
const ARTWORK_WALL_OFFSET_METRES = 0.1;
const MAX_FRAME_WIDTH_METRES = 1.82;
const MAX_FRAME_HEIGHT_METRES = 1.42;
const ROUNDING_EPSILON = 1e-9;

function normalizedArtworkCount(artworkCount) {
  if (!Number.isFinite(artworkCount)) return 0;
  return Math.max(0, Math.ceil(artworkCount));
}

function createArtworkAnchors(artworkCount, lengthM, widthM) {
  const count = normalizedArtworkCount(artworkCount);
  const worksPerLongWall = Math.ceil(count / 2);
  if (!worksPerLongWall) return Object.freeze([]);

  const usableLength = Math.max(0, lengthM - ARTWORK_SIDE_MARGIN_METRES * 2);
  const slotSpacing = worksPerLongWall > 1 ? usableLength / (worksPerLongWall - 1) : 0;

  return Object.freeze(Array.from({ length: count }, (_, index) => {
    const slotIndex = Math.floor(index / 2);
    const isLeftWall = index % 2 === 0;
    const x = -lengthM / 2 + ARTWORK_SIDE_MARGIN_METRES + slotIndex * slotSpacing;
    const z = isLeftWall ? -widthM / 2 + ARTWORK_WALL_OFFSET_METRES : widthM / 2 - ARTWORK_WALL_OFFSET_METRES;

    return Object.freeze({
      id: `slot-${String(index + 1).padStart(2, "0")}`,
      position: Object.freeze([x, 1.72, z]),
      normal: Object.freeze([0, 0, isLeftWall ? 1 : -1]),
      wall: isLeftWall ? "wall-left" : "wall-right",
      maxFrameWidthM: MAX_FRAME_WIDTH_METRES,
      maxFrameHeightM: MAX_FRAME_HEIGHT_METRES
    });
  }));
}

/**
 * Creates a bright, walk-through exhibition hall. The room is at least 25 × 8 m
 * and grows along its length when more works are added.
 */
export function createRoomForArtworkCount(artworkCount = 0) {
  const count = normalizedArtworkCount(artworkCount);
  const worksPerLongWall = Math.ceil(count / 2);
  const requiredLength = ARTWORK_SIDE_MARGIN_METRES * 2 + Math.max(0, worksPerLongWall - 1) * 2.6;
  const widthM = Math.max(
    MIN_ROOM_LENGTH_METRES,
    Math.ceil(requiredLength - ROUNDING_EPSILON)
  );
  const depthM = ROOM_WIDTH_METRES;

  return Object.freeze({
    widthM,
    depthM,
    heightM: 3.5,
    eyeHeightM: 1.6,
    stepM: 1,
    clearanceM: 0.35,
    turnDegrees: 15,
    startX: -widthM / 2 + ENTRANCE_VIEWPOINT_OFFSET_METRES,
    startZ: 0,
    startYawRadians: -Math.PI / 2,
    artworkAnchors: createArtworkAnchors(count, widthM, depthM)
  });
}

export const DEFAULT_ROOM = createRoomForArtworkCount();
export const ROOM = DEFAULT_ROOM;
