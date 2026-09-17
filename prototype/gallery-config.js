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

function modelArtworkAnchor(id, position, normal) {
  return Object.freeze({
    id,
    position: Object.freeze(position),
    normal: Object.freeze(normal),
    wall: "Line029",
    maxFrameWidthM: 1.69,
    maxFrameHeightM: 1.32
  });
}

/**
 * Measured mounting points on the `Line029` wall mesh in gallery-room.glb.
 * Coordinates are relative to the model after its runtime centring, and the
 * 2.5 cm viewer-facing offset keeps each frame visibly mounted on the wall.
 */
export const MODEL_ARTWORK_ANCHORS = Object.freeze([
  modelArtworkAnchor("slot-01", [-5.5, 1.48, 6.052], [0, 0, -1]),
  modelArtworkAnchor("slot-02", [7.126, 1.48, 5], [-1, 0, 0]),
  modelArtworkAnchor("slot-03", [-7.073, 1.48, 3], [1, 0, 0]),
  modelArtworkAnchor("slot-04", [-7.073, 1.48, 5], [1, 0, 0]),
  modelArtworkAnchor("slot-05", [7.126, 1.48, 0.9], [-1, 0, 0]),
  modelArtworkAnchor("slot-06", [7.126, 1.48, 3], [-1, 0, 0]),
  modelArtworkAnchor("slot-07", [-3, 1.48, 6.052], [0, 0, -1]),
  modelArtworkAnchor("slot-08", [-7.073, 1.48, 0.9], [1, 0, 0]),
  modelArtworkAnchor("slot-09", [4.5, 1.48, 6.052], [0, 0, -1]),
  modelArtworkAnchor("slot-10", [2, 1.48, 6.052], [0, 0, -1])
]);

/**
 * Physical dimensions measured from the imported gallery-room.glb architecture.
 * The model is centred at runtime so the camera and art placements use this
 * same coordinate system.
 */
export const MODEL_ROOM = Object.freeze({
  widthM: 14.83,
  depthM: 12.75,
  heightM: 3.71,
  eyeHeightM: 1.6,
  stepM: 1,
  clearanceM: 0.35,
  turnDegrees: 15,
  startX: -3,
  startZ: 3.875,
  artworkAnchors: MODEL_ARTWORK_ANCHORS
});

// Kept for gallery integrations that still import a static room definition.
export const ROOM = DEFAULT_ROOM;
