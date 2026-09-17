import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.1/build/three.module.js";
import { DEFAULT_ROOM } from "./gallery-config.js";

const POINTER_SENSITIVITY = 0.005;
const MAX_PITCH_RADIANS = THREE.MathUtils.degToRad(80);
const DRAG_THRESHOLD = 5;
const DEFAULT_NORMAL = new THREE.Vector3(0, 0, 1);
const FRAME_WIDTH_METRES = 0.07;

const DEGREE = 180 / Math.PI;

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
  const degrees = headingForYaw(yaw);
  if (degrees >= 315 || degrees < 45) return "к дальней стене";
  if (degrees < 135) return "к правой стене";
  if (degrees < 225) return "к входу";
  return "к левой стене";
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

function artworkPlacements(works, roomWidth) {
  const galleryWorks = Array.isArray(works) ? works : [];
  const artworkCount = galleryWorks.length;
  const slotsPerLongWall = Math.ceil(artworkCount / 2);
  const sideMargin = 1;
  const widestFrame = Math.max(
    0,
    ...galleryWorks.map((work) => artworkSize(work).width + FRAME_WIDTH_METRES * 2)
  );
  const usableWidth = Math.max(0, roomWidth - sideMargin * 2 - widestFrame);

  return Array.from({ length: artworkCount }, (_, index) => {
    const slot = Math.floor(index / 2);
    const x = slotsPerLongWall <= 1
      ? 0
      : -usableWidth / 2 + (usableWidth * slot) / (slotsPerLongWall - 1);
    return {
      wall: index % 2 === 0 ? "far" : "entry",
      x,
      y: 1.48
    };
  });
}

/**
 * Creates the visual WebGL room and its camera controller.
 *
 * This module deliberately owns only the canvas and 3D interaction. Labels,
 * buttons, focus and live-region announcements remain in the parent UI.
 */
export function createGalleryScene({
  mount,
  works = [],
  room = DEFAULT_ROOM,
  artworkImage,
  onArtworkClick,
  onStateChange
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
  const ART_POSITIONS = artworkPlacements(galleryWorks, ROOM_WIDTH);

  const scene = new THREE.Scene();
  const roomBackgroundColor = new THREE.Color(0xd8d2c8);
  const dimRoomBackgroundColor = new THREE.Color(0x282521);
  scene.background = roomBackgroundColor.clone();

  const camera = new THREE.PerspectiveCamera(63, 1, 0.05, CAMERA_FAR);
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const fullLightExposure = 1.05;
  const dimLightExposure = 0.28;
  renderer.toneMappingExposure = fullLightExposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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
  const controllableLights = [];
  const lightResponsiveMaterials = [];
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const artworkTextures = new Set();
  const textureLoader = new THREE.TextureLoader();
  let floorTexture = null;
  let positionX = Number.isFinite(roomConfig.startX) ? roomConfig.startX : 0;
  let positionZ = Number.isFinite(roomConfig.startZ) ? roomConfig.startZ : ROOM_DEPTH / 2 - 0.5;
  let yaw = 0;
  let pitch = 0;
  let activePointer = null;
  let disposed = false;
  let resizeObserver = null;
  let lightLevelPercent = 100;

  function rememberMesh(geometry, material) {
    geometries.add(geometry);
    if (Array.isArray(material)) material.forEach((item) => materials.add(item));
    else materials.add(material);
    return new THREE.Mesh(geometry, material);
  }

  function rememberLight(light) {
    controllableLights.push({ light, baseIntensity: light.intensity });
    return light;
  }

  function rememberLightResponsiveMaterial(material, dimColor) {
    lightResponsiveMaterials.push({
      material,
      baseColor: material.color.clone(),
      dimColor: new THREE.Color(dimColor)
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

    controllableLights.forEach(({ light, baseIntensity }) => {
      light.intensity = baseIntensity * intensityFactor;
    });
    lightResponsiveMaterials.forEach(({ material, baseColor, dimColor }) => {
      material.color.lerpColors(dimColor, baseColor, intensityFactor);
    });
    scene.background.lerpColors(dimRoomBackgroundColor, roomBackgroundColor, intensityFactor);
    renderer.toneMappingExposure = THREE.MathUtils.lerp(dimLightExposure, fullLightExposure, intensityFactor);
    render();
    return lightLevelPercent;
  }

  function wallPlacement(placement) {
    switch (placement.wall) {
      case "entry":
        return {
          position: new THREE.Vector3(placement.x, placement.y, ROOM_DEPTH / 2),
          normal: new THREE.Vector3(0, 0, -1)
        };
      case "left":
        return {
          position: new THREE.Vector3(-ROOM_WIDTH / 2, placement.y, placement.z),
          normal: new THREE.Vector3(1, 0, 0)
        };
      case "right":
        return {
          position: new THREE.Vector3(ROOM_WIDTH / 2, placement.y, placement.z),
          normal: new THREE.Vector3(-1, 0, 0)
        };
      default:
        return {
          position: new THREE.Vector3(placement.x, placement.y, -ROOM_DEPTH / 2),
          normal: new THREE.Vector3(0, 0, 1)
        };
    }
  }

  function syncCamera() {
    camera.position.set(positionX, EYE_HEIGHT, positionZ);
    camera.rotation.set(pitch, yaw, 0, "YXZ");
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

  function canMove(direction) {
    const vector = movementVector(direction);
    return Boolean(vector) && isClear(positionX + vector.x * STEP_METRES, positionZ + vector.z * STEP_METRES);
  }

  function getState() {
    return {
      x: rounded(positionX),
      z: rounded(positionZ),
      headingDegrees: Math.round(headingForYaw(yaw)) % 360,
      pitchDegrees: Math.round(pitch * DEGREE),
      lightLevelPercent,
      direction: directionForYaw(yaw),
      canForward: canMove("forward"),
      canBack: canMove("back"),
      canLeft: canMove("left"),
      canRight: canMove("right")
    };
  }

  function emit(type, moved, message) {
    onStateChange?.({ type, moved, state: getState(), message });
  }

  function createGalleryTileTexture() {
    const textureCanvas = document.createElement("canvas");
    textureCanvas.width = 1024;
    textureCanvas.height = 1024;
    const context = textureCanvas.getContext("2d");
    if (!context) return null;

    const tilesPerSide = 8;
    const tileSize = textureCanvas.width / tilesPerSide;
    const tileShades = ["#f7f4ed", "#f3efe6", "#eee9df", "#f5f1e9"];

    context.fillStyle = "#d9d2c6";
    context.fillRect(0, 0, textureCanvas.width, textureCanvas.height);

    for (let row = 0; row < tilesPerSide; row += 1) {
      for (let column = 0; column < tilesPerSide; column += 1) {
        const x = column * tileSize;
        const y = row * tileSize;
        const shadeIndex = (row * 3 + column * 5) % tileShades.length;
        const gradient = context.createLinearGradient(x, y, x + tileSize, y + tileSize);
        gradient.addColorStop(0, "#fbf9f4");
        gradient.addColorStop(0.52, tileShades[shadeIndex]);
        gradient.addColorStop(1, "#e9e3d8");
        context.fillStyle = gradient;
        context.fillRect(x + 1, y + 1, tileSize - 2, tileSize - 2);

        context.strokeStyle = "rgba(175, 165, 151, .11)";
        context.lineWidth = 1;
        context.beginPath();
        context.moveTo(x + tileSize * 0.14, y + tileSize * 0.73);
        context.lineTo(x + tileSize * 0.76, y + tileSize * 0.69);
        context.moveTo(x + tileSize * 0.31, y + tileSize * 0.27);
        context.lineTo(x + tileSize * 0.88, y + tileSize * 0.31);
        context.stroke();
      }
    }

    const texture = new THREE.CanvasTexture(textureCanvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(Math.max(1, ROOM_WIDTH / 4), Math.max(1, ROOM_DEPTH / 4));
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return texture;
  }

  function addRoom() {
    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0xebe4d9, roughness: 0.92, metalness: 0 });
    const floorMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.23, metalness: 0 });
    const ceilingMaterial = rememberLightResponsiveMaterial(new THREE.MeshBasicMaterial({ color: 0xf7f1e7, side: THREE.DoubleSide, toneMapped: false }), 0x3a332b);
    const ceilingInsetMaterial = rememberLightResponsiveMaterial(new THREE.MeshBasicMaterial({ color: 0xe8dfd2, toneMapped: false }), 0x302b25);
    const baseboardMaterial = new THREE.MeshStandardMaterial({ color: 0xd8d1c5, roughness: 0.74, metalness: 0 });
    const corniceMaterial = new THREE.MeshStandardMaterial({ color: 0xf4ede2, roughness: 0.9, metalness: 0 });

    floorTexture = createGalleryTileTexture();
    floorMaterial.map = floorTexture;

    const farWall = rememberMesh(new THREE.PlaneGeometry(ROOM_WIDTH, ROOM_HEIGHT), wallMaterial);
    farWall.position.set(0, ROOM_HEIGHT / 2, -ROOM_DEPTH / 2);
    scene.add(farWall);

    const entryWall = rememberMesh(new THREE.PlaneGeometry(ROOM_WIDTH, ROOM_HEIGHT), wallMaterial);
    entryWall.position.set(0, ROOM_HEIGHT / 2, ROOM_DEPTH / 2);
    entryWall.rotation.y = Math.PI;
    scene.add(entryWall);

    const leftWall = rememberMesh(new THREE.PlaneGeometry(ROOM_DEPTH, ROOM_HEIGHT), wallMaterial);
    leftWall.position.set(-ROOM_WIDTH / 2, ROOM_HEIGHT / 2, 0);
    leftWall.rotation.y = Math.PI / 2;
    scene.add(leftWall);

    const rightWall = rememberMesh(new THREE.PlaneGeometry(ROOM_DEPTH, ROOM_HEIGHT), wallMaterial);
    rightWall.position.set(ROOM_WIDTH / 2, ROOM_HEIGHT / 2, 0);
    rightWall.rotation.y = -Math.PI / 2;
    scene.add(rightWall);

    const floor = rememberMesh(new THREE.PlaneGeometry(ROOM_WIDTH, ROOM_DEPTH), floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.005;
    scene.add(floor);

    const ceiling = rememberMesh(new THREE.PlaneGeometry(ROOM_WIDTH, ROOM_DEPTH), ceilingMaterial);
    ceiling.position.y = ROOM_HEIGHT;
    ceiling.rotation.x = Math.PI / 2;
    scene.add(ceiling);

    const ceilingInset = rememberMesh(new THREE.BoxGeometry(ROOM_WIDTH - 0.52, 0.035, ROOM_DEPTH - 0.45), ceilingInsetMaterial);
    ceilingInset.position.set(0, ROOM_HEIGHT - 0.018, 0);
    scene.add(ceilingInset);

    const longBaseboard = new THREE.BoxGeometry(ROOM_WIDTH, 0.13, 0.07);
    const sideBaseboard = new THREE.BoxGeometry(0.07, 0.13, ROOM_DEPTH);
    const longCornice = new THREE.BoxGeometry(ROOM_WIDTH, 0.16, 0.12);
    const sideCornice = new THREE.BoxGeometry(0.12, 0.16, ROOM_DEPTH);

    [
      [longBaseboard, 0, 0.065, -ROOM_DEPTH / 2 + 0.035],
      [longBaseboard, 0, 0.065, ROOM_DEPTH / 2 - 0.035],
      [sideBaseboard, -ROOM_WIDTH / 2 + 0.035, 0.065, 0],
      [sideBaseboard, ROOM_WIDTH / 2 - 0.035, 0.065, 0]
    ].forEach(([geometry, x, y, z]) => {
      const trim = rememberMesh(geometry, baseboardMaterial);
      trim.position.set(x, y, z);
      scene.add(trim);
    });

    [
      [longCornice, 0, ROOM_HEIGHT - 0.08, -ROOM_DEPTH / 2 + 0.06],
      [longCornice, 0, ROOM_HEIGHT - 0.08, ROOM_DEPTH / 2 - 0.06],
      [sideCornice, -ROOM_WIDTH / 2 + 0.06, ROOM_HEIGHT - 0.08, 0],
      [sideCornice, ROOM_WIDTH / 2 - 0.06, ROOM_HEIGHT - 0.08, 0]
    ].forEach(([geometry, x, y, z]) => {
      const trim = rememberMesh(geometry, corniceMaterial);
      trim.position.set(x, y, z);
      scene.add(trim);
    });
  }

  function addLights() {
    scene.add(rememberLight(new THREE.HemisphereLight(0xfff8ee, 0xc9c3b8, 1.25)));

    const keyLight = rememberLight(new THREE.DirectionalLight(0xfff2dc, 2));
    keyLight.position.set(-ROOM_WIDTH * 0.28, ROOM_HEIGHT * 0.92, ROOM_DEPTH * 0.7);
    keyLight.target.position.set(0, 1.25, -ROOM_DEPTH * 0.28);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    const shadowSpan = Math.max(ROOM_WIDTH, ROOM_DEPTH) * 0.66;
    keyLight.shadow.camera.left = -shadowSpan;
    keyLight.shadow.camera.right = shadowSpan;
    keyLight.shadow.camera.top = shadowSpan;
    keyLight.shadow.camera.bottom = -shadowSpan;
    keyLight.shadow.camera.far = CAMERA_FAR * 2;
    keyLight.shadow.camera.updateProjectionMatrix();
    scene.add(keyLight, keyLight.target);

    const fillLight = rememberLight(new THREE.DirectionalLight(0xdde7ff, 0.48));
    fillLight.position.set(ROOM_WIDTH * 0.32, ROOM_HEIGHT * 0.76, -ROOM_DEPTH * 0.5);
    fillLight.target.position.set(0, 1.4, 0);
    scene.add(fillLight, fillLight.target);

    const trackMaterial = new THREE.MeshStandardMaterial({ color: 0x1e1d1a, roughness: 0.36, metalness: 0.62 });
    const fixtureMaterial = new THREE.MeshStandardMaterial({ color: 0x25231f, roughness: 0.34, metalness: 0.52 });
    const lensMaterial = rememberLightResponsiveMaterial(new THREE.MeshBasicMaterial({ color: 0xffe6bd, toneMapped: false }), 0x2c2115);
    const railGeometry = new THREE.BoxGeometry(ROOM_WIDTH - 1.2, 0.055, 0.075);
    const fixtureGeometry = new THREE.CylinderGeometry(0.07, 0.09, 0.14, 12);
    const lensGeometry = new THREE.CylinderGeometry(0.04, 0.04, 0.006, 12);
    const railZ = [-0.78, 0.78];
    const fixtureCount = Math.max(5, Math.ceil(ROOM_WIDTH / 3.5));
    const fixtureX = Array.from({ length: fixtureCount }, (_, index) => (
      fixtureCount === 1
        ? 0
        : THREE.MathUtils.lerp(-ROOM_WIDTH * 0.38, ROOM_WIDTH * 0.38, index / (fixtureCount - 1))
    ));

    railZ.forEach((z) => {
      const rail = rememberMesh(railGeometry, trackMaterial);
      rail.position.set(0, ROOM_HEIGHT - 0.17, z);
      scene.add(rail);

      fixtureX.forEach((x) => {
        const fixture = rememberMesh(fixtureGeometry, fixtureMaterial);
        fixture.position.set(x, ROOM_HEIGHT - 0.28, z);
        scene.add(fixture);

        const lens = rememberMesh(lensGeometry, lensMaterial);
        lens.position.set(x, ROOM_HEIGHT - 0.353, z);
        scene.add(lens);
      });
    });

    ART_POSITIONS.forEach((placement) => {
      const isEntryWall = placement.wall === "entry";
      const spotlight = rememberLight(new THREE.SpotLight(0xffe7c7, 7, 7, THREE.MathUtils.degToRad(24), 0.52, 1.3));
      spotlight.position.set(placement.x, ROOM_HEIGHT - 0.34, isEntryWall ? 0.78 : -0.78);
      spotlight.target.position.set(placement.x, placement.y, isEntryWall ? ROOM_DEPTH / 2 - 0.05 : -ROOM_DEPTH / 2 + 0.05);
      scene.add(spotlight, spotlight.target);
    });
  }

  function addArtwork(work, index) {
    const placement = ART_POSITIONS[index] || { wall: "far", x: 0, y: 1.48 };
    const { position, normal } = wallPlacement(placement);
    const { width, height } = artworkSize(work);
    const group = new THREE.Group();
    const frameDepth = 0.055;
    const frameWidth = FRAME_WIDTH_METRES;

    group.position.copy(position);
    group.quaternion.setFromUnitVectors(DEFAULT_NORMAL, normal);

    const frameMaterial = new THREE.MeshStandardMaterial({ color: 0x171716, roughness: 0.42, metalness: 0.16 });
    const frame = rememberMesh(new THREE.BoxGeometry(width + frameWidth * 2, height + frameWidth * 2, frameDepth), frameMaterial);
    frame.position.z = frameDepth / 2 + 0.012;
    frame.castShadow = true;
    frame.receiveShadow = true;
    frame.userData.work = work;
    group.add(frame);

    const imageMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: loadArtworkTexture(work.sceneImageSrc || work.imageSrc || artworkImage),
      side: THREE.FrontSide,
      toneMapped: false
    });
    const image = rememberMesh(new THREE.PlaneGeometry(width, height), imageMaterial);
    image.position.z = frameDepth + 0.026;
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
    const hit = raycaster.intersectObjects(artHitTargets, false)[0];
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
    emit("look", false);
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
    if (disposed || !movementDescription(direction)) return false;
    if (!canMove(direction)) {
      emit("blocked", false, blockedMovementDescription(direction));
      return false;
    }

    const vector = movementVector(direction);
    positionX += vector.x * STEP_METRES;
    positionZ += vector.z * STEP_METRES;
    syncCamera();
    render();
    emit("move", true, `Шаг на 1 метр ${movementDescription(direction)}. ${lookDescription(yaw, pitch)}`);
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
    addRoom();
    addLights();
    galleryWorks.forEach(addArtwork);
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
