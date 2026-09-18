import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js";
import { DEFAULT_ROOM } from "./gallery-config.js";

const POINTER_SENSITIVITY = 0.005;
const MAX_PITCH_RADIANS = THREE.MathUtils.degToRad(80);
const DRAG_THRESHOLD = 5;
const DEFAULT_NORMAL = new THREE.Vector3(0, 0, 1);
const FRAME_WIDTH_METRES = 0.07;
const MIN_ARTWORK_SPOTLIGHT_FACTOR = 1;
const MIN_ARTWORK_LENS_FACTOR = 1;
const MOVEMENT_DURATION_MS = 280;

const DEGREE = 180 / Math.PI;

function createAbortError() {
  const error = new Error("Gallery scene creation was cancelled.");
  error.name = "AbortError";
  return error;
}

function normaliseDegrees(radians) {
  const value = (radians * DEGREE) % 360;
  return value < 0 ? value + 360 : value;
}

function headingForYaw(yaw) {
  // 0° points to the far wall; degrees increase clockwise on the floor plan.
  return normaliseDegrees(-yaw);
}

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

function directionForYaw(yaw) {
  const x = -Math.sin(yaw);
  const z = -Math.cos(yaw);
  if (x > 0.707) return "к дальней стене";
  if (x < -0.707) return "к входу";
  return z < 0 ? "к левой стене" : "к правой стене";
}

function lookDescription(yaw, pitch) {
  const pitchDegrees = Math.round(pitch * DEGREE);
  const vertical = Math.abs(pitchDegrees) < 1
    ? ""
    : `, ${pitchDegrees > 0 ? "вверх" : "вниз"} на ${Math.abs(pitchDegrees)}°`;
  return `Взгляд ${directionForYaw(yaw)}${vertical}.`;
}

function artworkSize(work) {
  const displayWidth = Number(work?.displayWidthM);
  const displayHeight = Number(work?.displayHeightM);
  if (Number.isFinite(displayWidth) && displayWidth > 0 && Number.isFinite(displayHeight) && displayHeight > 0) {
    return { width: displayWidth, height: displayHeight };
  }

  const width = Number(work?.widthCm) / 100;
  const height = Number(work?.heightCm) / 100;

  return {
    width: Number.isFinite(width) && width > 0 ? width : 1,
    height: Number.isFinite(height) && height > 0 ? height : 1
  };
}

/**
 * Creates the visual WebGL room and its camera controller.
 *
 * This module deliberately owns only the canvas and 3D interaction. Labels,
 * buttons, focus and live-region announcements remain in the parent UI.
 */
export async function createGalleryScene({
  mount,
  works = [],
  room = DEFAULT_ROOM,
  artworkImage,
  onArtworkClick,
  onStateChange,
  signal
} = {}) {
  if (!mount || typeof mount.append !== "function") {
    throw new TypeError("createGalleryScene needs a valid mount element.");
  }
  const galleryWorks = Array.isArray(works) ? works : [];
  const roomConfig = room && typeof room === "object" ? room : DEFAULT_ROOM;
  const ROOM_WIDTH = Number.isFinite(roomConfig.widthM) && roomConfig.widthM > 0 ? roomConfig.widthM : DEFAULT_ROOM.widthM;
  const ROOM_DEPTH = Number.isFinite(roomConfig.depthM) && roomConfig.depthM > 0 ? roomConfig.depthM : DEFAULT_ROOM.depthM;
  const ROOM_HEIGHT = Number.isFinite(roomConfig.heightM) && roomConfig.heightM > 0 ? roomConfig.heightM : DEFAULT_ROOM.heightM;
  const EYE_HEIGHT = Number.isFinite(roomConfig.eyeHeightM) && roomConfig.eyeHeightM > 0 ? roomConfig.eyeHeightM : DEFAULT_ROOM.eyeHeightM;
  const STEP_METRES = Number.isFinite(roomConfig.stepM) && roomConfig.stepM > 0 ? roomConfig.stepM : DEFAULT_ROOM.stepM;
  const WALL_CLEARANCE = Number.isFinite(roomConfig.clearanceM) && roomConfig.clearanceM >= 0 ? roomConfig.clearanceM : DEFAULT_ROOM.clearanceM;
  const TURN_RADIANS = THREE.MathUtils.degToRad(Number.isFinite(roomConfig.turnDegrees) ? roomConfig.turnDegrees : DEFAULT_ROOM.turnDegrees);
  const CAMERA_FAR = Math.hypot(ROOM_WIDTH, ROOM_DEPTH, ROOM_HEIGHT) + 5;
  const WALL_LIMIT_X = ROOM_WIDTH / 2 - WALL_CLEARANCE;
  const WALL_LIMIT_Z = ROOM_DEPTH / 2 - WALL_CLEARANCE;
  const ARTWORK_ANCHORS = Array.isArray(roomConfig.artworkAnchors) ? roomConfig.artworkAnchors : [];

  if (galleryWorks.length > ARTWORK_ANCHORS.length) {
    throw new RangeError(`The gallery has ${ARTWORK_ANCHORS.length} configured artwork anchors, but received ${galleryWorks.length} works.`);
  }

  if (signal?.aborted) throw createAbortError();

  const scene = new THREE.Scene();
  const roomBackgroundColor = new THREE.Color(0xe9e4da);
  const dimRoomBackgroundColor = new THREE.Color(0x49443e);
  scene.background = roomBackgroundColor.clone();

  const camera = new THREE.PerspectiveCamera(63, 1, 0.05, CAMERA_FAR);
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const fullLightExposure = 1.04;
  renderer.toneMappingExposure = fullLightExposure;
  renderer.shadowMap.enabled = false;

  const canvas = renderer.domElement;
  canvas.className = "gallery-scene-canvas";
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.touchAction = "none";
  canvas.style.cursor = "grab";
  mount.prepend(canvas);

  const geometries = new Set();
  const materials = new Set();
  const artHitTargets = [];
  const roomCollisionTargets = [];
  const controllableLights = [];
  const lightResponsiveMaterials = [];
  const raycaster = new THREE.Raycaster();
  const wallRaycaster = new THREE.Raycaster();
  const artworkAnchorRaycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const artworkTextures = new Set();
  const textureLoader = new THREE.TextureLoader();
  let floorTexture = null;
  let positionX = Number.isFinite(roomConfig.startX) ? roomConfig.startX : 0;
  let positionZ = Number.isFinite(roomConfig.startZ) ? roomConfig.startZ : ROOM_DEPTH / 2 - 0.5;
  let yaw = Number.isFinite(roomConfig.startYawRadians) ? roomConfig.startYawRadians : 0;
  let pitch = 0;
  let activePointer = null;
  let disposed = false;
  let resizeObserver = null;
  let lightLevelPercent = 100;
  let isMoving = false;
  let movementAnimationFrame = null;
  let movementTarget = null;

  function rememberMaterial(material) {
    if (Array.isArray(material)) material.forEach((item) => rememberMaterial(item));
    else if (material) materials.add(material);
    return material;
  }

  function rememberMesh(geometry, material) {
    geometries.add(geometry);
    rememberMaterial(material);
    return new THREE.Mesh(geometry, material);
  }

  function rememberLight(light, minimumIntensityFactor = 0) {
    controllableLights.push({
      light,
      baseIntensity: light.intensity,
      minimumIntensityFactor: THREE.MathUtils.clamp(minimumIntensityFactor, 0, 1)
    });
    return light;
  }

  function rememberLightResponsiveMaterial(material, dimColor, minimumLightFactor = 0) {
    lightResponsiveMaterials.push({
      material,
      baseColor: material.color.clone(),
      dimColor: new THREE.Color(dimColor),
      minimumLightFactor: THREE.MathUtils.clamp(minimumLightFactor, 0, 1)
    });
    return material;
  }

  function render() {
    if (!disposed) renderer.render(scene, camera);
  }

  function setLightLevel(percent) {
    const numericPercent = Number(percent);
    lightLevelPercent = Math.round(THREE.MathUtils.clamp(Number.isFinite(numericPercent) ? numericPercent : 100, 0, 100));
    const intensityFactor = lightLevelPercent / 100;

    controllableLights.forEach(({ light, baseIntensity, minimumIntensityFactor }) => {
      const adjustedIntensityFactor = THREE.MathUtils.lerp(minimumIntensityFactor, 1, intensityFactor);
      light.intensity = baseIntensity * adjustedIntensityFactor;
    });
    lightResponsiveMaterials.forEach(({ material, baseColor, dimColor, minimumLightFactor }) => {
      const adjustedColorFactor = THREE.MathUtils.lerp(minimumLightFactor, 1, intensityFactor);
      material.color.lerpColors(dimColor, baseColor, adjustedColorFactor);
    });
    scene.background.lerpColors(dimRoomBackgroundColor, roomBackgroundColor, intensityFactor);
    render();
    return lightLevelPercent;
  }

  function readArtworkAnchor(anchor, index) {
    const label = anchor?.id || `slot-${index + 1}`;
    const position = Array.isArray(anchor?.position) ? new THREE.Vector3(...anchor.position) : null;
    const normal = Array.isArray(anchor?.normal) ? new THREE.Vector3(...anchor.normal) : null;

    if (!position?.toArray().every(Number.isFinite) || !normal?.toArray().every(Number.isFinite) || normal.lengthSq() === 0) {
      throw new TypeError(`Artwork anchor ${label} is invalid.`);
    }

    return { anchor, label, position, normal: normal.normalize() };
  }

  function resolveArtworkPlacement(work, index) {
    const { anchor, label, position, normal } = readArtworkAnchor(ARTWORK_ANCHORS[index], index);
    const { width, height } = artworkSize(work);
    const framedWidth = width + FRAME_WIDTH_METRES * 2;
    const framedHeight = height + FRAME_WIDTH_METRES * 2;
    const maxFrameWidth = Number(anchor.maxFrameWidthM);
    const maxFrameHeight = Number(anchor.maxFrameHeightM);

    if (!Number.isFinite(maxFrameWidth) || !Number.isFinite(maxFrameHeight)) {
      throw new TypeError(`Artwork anchor ${label} has no valid frame dimensions.`);
    }

    if (framedWidth > maxFrameWidth || framedHeight > maxFrameHeight) {
      throw new RangeError(`Artwork ${index + 1} does not fit ${label}.`);
    }

    const targetWalls = roomCollisionTargets.filter((object) => object.name === anchor.wall);
    artworkAnchorRaycaster.set(position.clone().addScaledVector(normal, 0.12), normal.clone().negate());
    artworkAnchorRaycaster.near = 0.001;
    artworkAnchorRaycaster.far = 0.2;
    const hit = artworkAnchorRaycaster.intersectObjects(targetWalls, false)[0];

    if (!hit) {
      throw new Error(`Artwork anchor ${label} does not match the ${anchor.wall} wall.`);
    }

    return { work, position, normal, width, height };
  }

  function syncCamera() {
    camera.position.set(positionX, EYE_HEIGHT, positionZ);
    camera.rotation.set(pitch, yaw, 0, "YXZ");
  }

  function prefersReducedMotion() {
    return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  }

  function easedMovement(progress) {
    return progress < 0.5
      ? 4 * progress * progress * progress
      : 1 - ((-2 * progress + 2) ** 3) / 2;
  }

  function forwardVector() {
    return {
      x: -Math.sin(yaw),
      z: -Math.cos(yaw)
    };
  }

  function movementVector(direction) {
    const forward = forwardVector();
    switch (direction) {
      case "forward":
        return forward;
      case "back":
        return { x: -forward.x, z: -forward.z };
      case "left":
        return { x: -Math.cos(yaw), z: Math.sin(yaw) };
      case "right":
        return { x: Math.cos(yaw), z: -Math.sin(yaw) };
      default:
        return null;
    }
  }

  function movementDescription(direction) {
    return {
      forward: "вперёд",
      back: "назад",
      left: "влево",
      right: "вправо"
    }[direction];
  }

  function blockedMovementDescription(direction) {
    return {
      forward: "Впереди стена: шаг на 1 метр невозможен.",
      back: "Позади стена: шаг на 1 метр невозможен.",
      left: "Слева стена: шаг на 1 метр невозможен.",
      right: "Справа стена: шаг на 1 метр невозможен."
    }[direction];
  }

  function isClear(x, z) {
    return x >= -WALL_LIMIT_X && x <= WALL_LIMIT_X && z >= -WALL_LIMIT_Z && z <= WALL_LIMIT_Z;
  }

  function isBlockedByRoomGeometry(vector) {
    if (!roomCollisionTargets.length) return false;

    const direction = new THREE.Vector3(vector.x, 0, vector.z).normalize();
    const lateral = new THREE.Vector3(-direction.z, 0, direction.x);
    const shoulderClearance = Math.min(Math.max(WALL_CLEARANCE, 0.18), 0.28);
    const travelDistance = STEP_METRES + shoulderClearance;
    const shoulderHeight = Math.min(EYE_HEIGHT * 0.72, ROOM_HEIGHT - 0.25);
    const origin = new THREE.Vector3();
    const offsets = [-shoulderClearance, 0, shoulderClearance];

    return offsets.some((offset) => {
      origin.set(positionX, shoulderHeight, positionZ).addScaledVector(lateral, offset);
      wallRaycaster.set(origin, direction);
      wallRaycaster.near = 0.06;
      wallRaycaster.far = travelDistance;
      const hit = wallRaycaster.intersectObjects(roomCollisionTargets, false).find((intersection) => {
        const normal = intersection.face?.normal?.clone().transformDirection(intersection.object.matrixWorld);
        return normal && Math.abs(normal.y) < 0.45;
      });
      return Boolean(hit);
    });
  }

  function canMove(direction) {
    const vector = movementVector(direction);
    return Boolean(vector)
      && isClear(positionX + vector.x * STEP_METRES, positionZ + vector.z * STEP_METRES)
      && !isBlockedByRoomGeometry(vector);
  }

  function getState(includeMovementAvailability = true) {
    const state = {
      x: rounded(positionX),
      z: rounded(positionZ),
      headingDegrees: Math.round(headingForYaw(yaw)) % 360,
      pitchDegrees: Math.round(pitch * DEGREE),
      lightLevelPercent,
      isMoving,
      targetX: movementTarget?.x,
      targetZ: movementTarget?.z,
      direction: directionForYaw(yaw)
    };

    if (includeMovementAvailability) {
      state.canForward = !isMoving && canMove("forward");
      state.canBack = !isMoving && canMove("back");
      state.canLeft = !isMoving && canMove("left");
      state.canRight = !isMoving && canMove("right");
    }

    return state;
  }

  function emit(type, moved, message, includeMovementAvailability = true) {
    onStateChange?.({ type, moved, state: getState(includeMovementAvailability), message });
  }

  function createGalleryWoodFloorTexture() {
    const textureCanvas = document.createElement("canvas");
    textureCanvas.width = 1024;
    textureCanvas.height = 1024;
    const context = textureCanvas.getContext("2d");
    if (!context) return null;

    const boardCount = 40;
    const boardWidth = textureCanvas.width / boardCount;
    const boardShades = ["#d8ab70", "#c8965c", "#e1bc82", "#b9854e", "#d1a269", "#e7c28c"];
    const seamColor = "rgba(84, 52, 28, .2)";

    context.fillStyle = "#c9935a";
    context.fillRect(0, 0, textureCanvas.width, textureCanvas.height);

    for (let board = 0; board < boardCount; board += 1) {
      const x = board * boardWidth;
      const offset = (board * 173) % 314;
      const segmentHeights = [338, 426, 292, 484];
      let y = -offset;
      let segment = 0;

      while (y < textureCanvas.height) {
        const height = segmentHeights[(board + segment * 3) % segmentHeights.length];
        const shade = boardShades[(board * 5 + segment * 2) % boardShades.length];
        const gradient = context.createLinearGradient(x, y, x + boardWidth, y + height);
        gradient.addColorStop(0, "#f0cf9d");
        gradient.addColorStop(0.22, shade);
        gradient.addColorStop(0.78, shade);
        gradient.addColorStop(1, "#a87445");
        context.fillStyle = gradient;
        context.fillRect(x + 1, y + 1, boardWidth - 2, height - 2);

        context.strokeStyle = seamColor;
        context.lineWidth = 2;
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x + boardWidth, y);
        context.stroke();

        y += height;
        segment += 1;
      }

      context.strokeStyle = "rgba(84, 52, 28, .28)";
      context.lineWidth = 1.4;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, textureCanvas.height);
      context.stroke();

      for (let grain = 0; grain < 4; grain += 1) {
        const grainX = x + boardWidth * ((grain + 1) / 5);
        context.strokeStyle = "rgba(103, 65, 39, .14)";
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(grainX, 0);
        context.bezierCurveTo(grainX - 8, 260, grainX + 8, 620, grainX - 3, textureCanvas.height);
        context.stroke();
      }
    }

    const texture = new THREE.CanvasTexture(textureCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1, 1);
    texture.center.set(0.5, 0.5);
    texture.rotation = Math.PI / 2;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return texture;
  }

  function addRoomShell() {
    const wallThickness = 0.12;
    const wallMaterial = rememberLightResponsiveMaterial(new THREE.MeshStandardMaterial({
      color: 0xf1eee7,
      roughness: 0.84,
      metalness: 0
    }), 0x716b63);
    const floorMaterial = rememberMaterial(new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x1c0d03,
      emissiveIntensity: 0.06,
      roughness: 0.56,
      metalness: 0,
      side: THREE.DoubleSide
    }));
    const ceilingMaterial = rememberLightResponsiveMaterial(new THREE.MeshBasicMaterial({
      color: 0xf9f6ef,
      side: THREE.DoubleSide,
      toneMapped: false
    }), 0x605b54);
    const trimMaterial = rememberLightResponsiveMaterial(new THREE.MeshStandardMaterial({
      color: 0xd9d4ca,
      roughness: 0.66,
      metalness: 0
    }), 0x615c54);

    floorTexture = createGalleryWoodFloorTexture();
    floorMaterial.map = floorTexture;

    const floor = rememberMesh(new THREE.PlaneGeometry(ROOM_WIDTH, ROOM_DEPTH), floorMaterial);
    floor.name = "gallery-floor";
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = 0.006;
    floor.receiveShadow = false;
    scene.add(floor);

    const ceiling = rememberMesh(new THREE.PlaneGeometry(ROOM_WIDTH, ROOM_DEPTH), ceilingMaterial);
    ceiling.name = "gallery-ceiling";
    ceiling.position.y = ROOM_HEIGHT;
    ceiling.rotation.x = Math.PI / 2;
    scene.add(ceiling);

    function addWall(name, geometry, position) {
      const wall = rememberMesh(geometry, wallMaterial);
      wall.name = name;
      wall.position.copy(position);
      wall.castShadow = false;
      wall.receiveShadow = false;
      roomCollisionTargets.push(wall);
      scene.add(wall);
    }

    addWall("wall-left", new THREE.BoxGeometry(ROOM_WIDTH, ROOM_HEIGHT, wallThickness), new THREE.Vector3(0, ROOM_HEIGHT / 2, -ROOM_DEPTH / 2));
    addWall("wall-right", new THREE.BoxGeometry(ROOM_WIDTH, ROOM_HEIGHT, wallThickness), new THREE.Vector3(0, ROOM_HEIGHT / 2, ROOM_DEPTH / 2));
    addWall("wall-entry", new THREE.BoxGeometry(wallThickness, ROOM_HEIGHT, ROOM_DEPTH), new THREE.Vector3(-ROOM_WIDTH / 2, ROOM_HEIGHT / 2, 0));
    addWall("wall-far", new THREE.BoxGeometry(wallThickness, ROOM_HEIGHT, ROOM_DEPTH), new THREE.Vector3(ROOM_WIDTH / 2, ROOM_HEIGHT / 2, 0));

    const baseboardHeight = 0.1;
    const baseboardDepth = 0.035;
    const sideBaseboardGeometry = new THREE.BoxGeometry(ROOM_WIDTH, baseboardHeight, baseboardDepth);
    const endBaseboardGeometry = new THREE.BoxGeometry(baseboardDepth, baseboardHeight, ROOM_DEPTH);
    const corniceHeight = 0.075;
    const sideCorniceGeometry = new THREE.BoxGeometry(ROOM_WIDTH, corniceHeight, 0.09);
    const endCorniceGeometry = new THREE.BoxGeometry(0.09, corniceHeight, ROOM_DEPTH);

    [
      [sideBaseboardGeometry, 0, baseboardHeight / 2, -ROOM_DEPTH / 2 + baseboardDepth / 2],
      [sideBaseboardGeometry, 0, baseboardHeight / 2, ROOM_DEPTH / 2 - baseboardDepth / 2],
      [endBaseboardGeometry, -ROOM_WIDTH / 2 + baseboardDepth / 2, baseboardHeight / 2, 0],
      [endBaseboardGeometry, ROOM_WIDTH / 2 - baseboardDepth / 2, baseboardHeight / 2, 0],
      [sideCorniceGeometry, 0, ROOM_HEIGHT - corniceHeight / 2, -ROOM_DEPTH / 2 + 0.045],
      [sideCorniceGeometry, 0, ROOM_HEIGHT - corniceHeight / 2, ROOM_DEPTH / 2 - 0.045],
      [endCorniceGeometry, -ROOM_WIDTH / 2 + 0.045, ROOM_HEIGHT - corniceHeight / 2, 0],
      [endCorniceGeometry, ROOM_WIDTH / 2 - 0.045, ROOM_HEIGHT - corniceHeight / 2, 0]
    ].forEach(([geometry, x, y, z]) => {
      const trim = rememberMesh(geometry, trimMaterial);
      trim.position.set(x, y, z);
      trim.receiveShadow = false;
      scene.add(trim);
    });

    scene.updateMatrixWorld(true);
  }

  function addLights(artworkPlacements) {
    scene.add(rememberLight(new THREE.HemisphereLight(0xfffbf4, 0xc3b49f, 0.85)));

    const keyLight = rememberLight(new THREE.DirectionalLight(0xfff1d9, 0.26));
    keyLight.position.set(-ROOM_WIDTH * 0.28, ROOM_HEIGHT * 0.92, ROOM_DEPTH * 0.7);
    keyLight.target.position.set(0, 1.25, -ROOM_DEPTH * 0.28);
    keyLight.castShadow = false;
    scene.add(keyLight, keyLight.target);

    const fillLight = rememberLight(new THREE.DirectionalLight(0xe0e8f1, 0.12));
    fillLight.position.set(ROOM_WIDTH * 0.32, ROOM_HEIGHT * 0.76, -ROOM_DEPTH * 0.5);
    fillLight.target.position.set(0, 1.4, 0);
    scene.add(fillLight, fillLight.target);

    const trackMaterial = rememberMaterial(new THREE.MeshStandardMaterial({ color: 0x151412, roughness: 0.34, metalness: 0.72 }));
    const fixtureMaterial = rememberMaterial(new THREE.MeshStandardMaterial({ color: 0x292622, roughness: 0.3, metalness: 0.58 }));
    const lensMaterial = rememberLightResponsiveMaterial(
      new THREE.MeshBasicMaterial({ color: 0xffd8a0, toneMapped: false }),
      0x2b1b0d,
      MIN_ARTWORK_LENS_FACTOR
    );
    const fixtureGeometry = new THREE.CylinderGeometry(0.072, 0.104, 0.19, 12);
    const lensGeometry = new THREE.CylinderGeometry(0.055, 0.055, 0.008, 16);
    const mountGeometry = new THREE.CylinderGeometry(0.022, 0.022, 0.16, 8);
    const downAxis = new THREE.Vector3(0, -1, 0);
    const trackGroups = new Map();

    artworkPlacements.forEach((placement) => {
      const normal = placement.normal;
      const key = `${Math.round(normal.x)},${Math.round(normal.z)}`;
      const group = trackGroups.get(key) || [];
      group.push(placement);
      trackGroups.set(key, group);
    });

    trackGroups.forEach((placements) => {
      const normal = placements[0].normal;
      const tangent = new THREE.Vector3(-normal.z, 0, normal.x);
      const mountPoints = placements.map(({ position }) => {
        const mountPoint = position.clone().addScaledVector(normal, 0.78);
        mountPoint.y = ROOM_HEIGHT - 0.17;
        return mountPoint;
      });
      const distances = mountPoints.map((point) => point.dot(tangent));
      const start = Math.min(...distances) - 0.48;
      const end = Math.max(...distances) + 0.48;
      const normalOffset = mountPoints[0].dot(normal);
      const railCenter = tangent.clone().multiplyScalar((start + end) / 2).addScaledVector(normal, normalOffset);
      railCenter.y = ROOM_HEIGHT - 0.17;

      const rail = rememberMesh(new THREE.BoxGeometry(end - start, 0.055, 0.082), trackMaterial);
      rail.name = "artwork-track-rail";
      rail.position.copy(railCenter);
      rail.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), tangent);
      scene.add(rail);
    });

    artworkPlacements.forEach(({ position, normal, height }) => {
      const mountPosition = position.clone().addScaledVector(normal, 0.78);
      mountPosition.y = ROOM_HEIGHT - 0.17;
      const headPosition = mountPosition.clone();
      headPosition.y -= 0.12;
      const artworkTarget = position.clone();
      artworkTarget.y += Number.isFinite(height) ? Math.min(height * 0.08, 0.16) : 0;
      const aimDirection = artworkTarget.clone().sub(headPosition).normalize();

      const mount = rememberMesh(mountGeometry, fixtureMaterial);
      mount.name = "artwork-track-mount";
      mount.position.copy(mountPosition);
      mount.position.y -= 0.08;
      scene.add(mount);

      const fixture = new THREE.Group();
      fixture.name = "artwork-track-spotlight";
      fixture.position.copy(headPosition);
      fixture.quaternion.setFromUnitVectors(downAxis, aimDirection);

      const housing = rememberMesh(fixtureGeometry, fixtureMaterial);
      const lens = rememberMesh(lensGeometry, lensMaterial);
      lens.position.y = -0.099;
      fixture.add(housing, lens);
      scene.add(fixture);

      const spotlight = rememberLight(
        new THREE.SpotLight(0xffdfa9, 15, 4.8, THREE.MathUtils.degToRad(22), 0.62, 1.4),
        MIN_ARTWORK_SPOTLIGHT_FACTOR
      );
      spotlight.castShadow = false;
      spotlight.position.copy(headPosition).addScaledVector(aimDirection, 0.105);
      spotlight.target.position.copy(artworkTarget);
      scene.add(spotlight, spotlight.target);
    });
  }

  function addArtwork({ work, position, normal, width, height }) {
    const group = new THREE.Group();
    const frameDepth = 0.055;
    const frameWidth = FRAME_WIDTH_METRES;

    group.position.copy(position);
    group.quaternion.setFromUnitVectors(DEFAULT_NORMAL, normal);

    const frameMaterial = new THREE.MeshStandardMaterial({ color: 0x171716, roughness: 0.42, metalness: 0.16 });
    const frame = rememberMesh(new THREE.BoxGeometry(width + frameWidth * 2, height + frameWidth * 2, frameDepth), frameMaterial);
    frame.position.z = frameDepth / 2 + 0.012;
    frame.castShadow = false;
    frame.receiveShadow = false;
    frame.userData.work = work;
    group.add(frame);

    const imageMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: loadArtworkTexture(work.sceneImageSrc || work.imageSrc || artworkImage),
      emissive: 0x110c08,
      emissiveIntensity: 0.06,
      roughness: 0.82,
      metalness: 0,
      side: THREE.FrontSide,
      toneMapped: true
    });
    const image = rememberMesh(new THREE.PlaneGeometry(width, height), imageMaterial);
    image.position.z = frameDepth + 0.026;
    image.castShadow = false;
    image.receiveShadow = false;
    image.userData.work = work;
    group.add(image);

    artHitTargets.push(frame, image);
    scene.add(group);
  }

  function loadArtworkTexture(sourcePath) {
    if (!sourcePath) return null;
    const source = new URL(sourcePath, window.location.href).href;
    const texture = textureLoader.load(
      source,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        render();
      },
      undefined,
      () => render()
    );
    texture.colorSpace = THREE.SRGBColorSpace;
    artworkTextures.add(texture);
    return texture;
  }

  function raycastArtwork(clientX, clientY) {
    if (!artHitTargets.length) return;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;

    pointer.x = ((clientX - bounds.left) / bounds.width) * 2 - 1;
    pointer.y = -((clientY - bounds.top) / bounds.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects([...roomCollisionTargets, ...artHitTargets], false)[0];
    const work = hit?.object?.userData?.work;
    if (work) onArtworkClick?.(work);
  }

  function handlePointerDown(event) {
    if (disposed || event.button !== 0 || activePointer) return;
    activePointer = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      yaw,
      pitch,
      dragged: false
    };
    canvas.style.cursor = "grabbing";
    canvas.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event) {
    if (!activePointer || event.pointerId !== activePointer.id) return;
    const distance = Math.hypot(event.clientX - activePointer.x, event.clientY - activePointer.y);
    if (distance < DRAG_THRESHOLD && !activePointer.dragged) return;

    activePointer.dragged = true;
    yaw = activePointer.yaw - (event.clientX - activePointer.x) * POINTER_SENSITIVITY;
    pitch = THREE.MathUtils.clamp(
      activePointer.pitch - (event.clientY - activePointer.y) * POINTER_SENSITIVITY,
      -MAX_PITCH_RADIANS,
      MAX_PITCH_RADIANS
    );
    syncCamera();
    render();
    emit("look", false, undefined, false);
  }

  function clearActivePointer(pointerId) {
    if (!activePointer || pointerId !== activePointer.id) return null;
    const pointerState = activePointer;
    activePointer = null;
    canvas.style.cursor = "grab";
    return pointerState;
  }

  function releasePointer(event, cancelled = false) {
    const pointerState = clearActivePointer(event.pointerId);
    if (!pointerState) return;
    if (canvas.hasPointerCapture?.(event.pointerId)) canvas.releasePointerCapture(event.pointerId);

    if (pointerState.dragged) {
      if (!cancelled) emit("look", false, lookDescription(yaw, pitch));
      return;
    }

    if (!cancelled) raycastArtwork(event.clientX, event.clientY);
  }

  function handlePointerUp(event) {
    releasePointer(event);
  }

  function handlePointerCancel(event) {
    releasePointer(event, true);
  }

  function handleLostPointerCapture(event) {
    clearActivePointer(event.pointerId);
  }

  function resize() {
    if (disposed) return;
    const width = Math.max(1, mount.clientWidth || window.innerWidth);
    const height = Math.max(1, mount.clientHeight || window.innerHeight);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    render();
  }

  function move(direction) {
    if (disposed || isMoving || !movementDescription(direction)) return false;
    if (!canMove(direction)) {
      emit("blocked", false, blockedMovementDescription(direction));
      return false;
    }

    const vector = movementVector(direction);
    const startX = positionX;
    const startZ = positionZ;
    const targetX = startX + vector.x * STEP_METRES;
    const targetZ = startZ + vector.z * STEP_METRES;
    const completedMessage = `Шаг на 1 метр ${movementDescription(direction)}. ${lookDescription(yaw, pitch)}`;

    const finishMove = () => {
      positionX = targetX;
      positionZ = targetZ;
      isMoving = false;
      movementAnimationFrame = null;
      movementTarget = null;
      syncCamera();
      render();
      emit("move", true, completedMessage);
    };

    if (prefersReducedMotion()) {
      finishMove();
      return true;
    }

    isMoving = true;
    movementTarget = { x: targetX, z: targetZ };
    emit("move-start", false);
    let startTime = null;
    const animateMove = (timestamp) => {
      if (disposed) return;
      if (startTime === null) startTime = timestamp;
      const progress = Math.min(1, (timestamp - startTime) / MOVEMENT_DURATION_MS);
      const easedProgress = easedMovement(progress);
      positionX = THREE.MathUtils.lerp(startX, targetX, easedProgress);
      positionZ = THREE.MathUtils.lerp(startZ, targetZ, easedProgress);
      syncCamera();
      render();

      if (progress < 1) {
        movementAnimationFrame = requestAnimationFrame(animateMove);
        return;
      }

      finishMove();
    };
    movementAnimationFrame = requestAnimationFrame(animateMove);
    return true;
  }

  function turn(direction) {
    if (disposed || (direction !== "left" && direction !== "right")) return false;
    yaw += direction === "left" ? TURN_RADIANS : -TURN_RADIANS;
    syncCamera();
    render();
    emit("turn", false, `Поворот ${direction === "left" ? "влево" : "вправо"} на 15°. ${lookDescription(yaw, pitch)}`);
    return true;
  }

  function tilt(direction) {
    if (disposed || (direction !== "up" && direction !== "down")) return false;
    const sign = direction === "up" ? 1 : -1;
    pitch = THREE.MathUtils.clamp(pitch + sign * TURN_RADIANS, -MAX_PITCH_RADIANS, MAX_PITCH_RADIANS);
    syncCamera();
    render();
    emit("tilt", false, lookDescription(yaw, pitch));
    return true;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (movementAnimationFrame !== null) cancelAnimationFrame(movementAnimationFrame);
    movementTarget = null;
    resizeObserver?.disconnect();
    window.removeEventListener("resize", resize);
    canvas.removeEventListener("pointerdown", handlePointerDown);
    canvas.removeEventListener("pointermove", handlePointerMove);
    canvas.removeEventListener("pointerup", handlePointerUp);
    canvas.removeEventListener("pointercancel", handlePointerCancel);
    canvas.removeEventListener("lostpointercapture", handleLostPointerCapture);
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    floorTexture?.dispose();
    artworkTextures.forEach((texture) => texture.dispose());
    renderer.dispose();
    renderer.forceContextLoss?.();
    canvas.remove();
  }

  try {
    if (signal?.aborted) throw createAbortError();
    addRoomShell();
    const resolvedArtworkPlacements = galleryWorks.map(resolveArtworkPlacement);
    addLights(resolvedArtworkPlacements);
    resolvedArtworkPlacements.forEach(addArtwork);
    syncCamera();

    resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    resizeObserver?.observe(mount);
    window.addEventListener("resize", resize);
    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointercancel", handlePointerCancel);
    canvas.addEventListener("lostpointercapture", handleLostPointerCapture);
    resize();
    emit("ready", false, `Точка обзора у входа. ${lookDescription(yaw, pitch)}`);

    return { move, turn, tilt, setLightLevel, dispose, getState };
  } catch (error) {
    dispose();
    throw error;
  }
}
