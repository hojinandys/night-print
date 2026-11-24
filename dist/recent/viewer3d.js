import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';
import { LineSegments2 } from './vendor/LineSegments2.js';
import { LineSegmentsGeometry } from './vendor/LineSegmentsGeometry.js';
import { LineMaterial } from './vendor/LineMaterial.js';

// Three.js 0.187.0, distributed locally under the included MIT license.
// Geometry packets preserve the original Blender display geometry; values are never inferred from images.
const packetCache = new Map();
const interactionCache = new Map();
async function interactionData(url) {
  if (!url) return null;
  if (!interactionCache.has(url)) {
    const request = fetch(url).then((response) => { if (!response.ok) throw new Error('Location geometry unavailable'); return response.json(); });
    interactionCache.set(url, request);
    request.catch(() => interactionCache.delete(url));
  }
  return interactionCache.get(url);
}
async function packet(url) {
  if (packetCache.has(url)) {
    const cached = packetCache.get(url);
    packetCache.delete(url); packetCache.set(url, cached);
    return cached;
  }
  const pending = (async () => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Geometry ${response.status}`);
    let buffer = await response.arrayBuffer();
    const signature = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
    if (signature[0] === 0x1f && signature[1] === 0x8b) {
      if (!globalThis.DecompressionStream) throw new Error('Gzip decompression unavailable');
      buffer = await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    }
    if (new TextDecoder().decode(new Uint8Array(buffer, 0, 8)) !== 'NPG3D001') throw new Error('Invalid geometry packet');
    const view = new DataView(buffer), headerSize = view.getUint32(8, true), start = view.getUint32(12, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 16, headerSize)));
    const arrays = {};
    for (const [name, spec] of Object.entries(header.arrays)) {
      const Type = { float32: Float32Array, float64: Float64Array, uint32: Uint32Array }[spec.dtype];
      if (!Type || start + spec.byte_offset + spec.byte_length > buffer.byteLength) throw new Error('Invalid geometry array');
      arrays[name] = new Type(buffer, start + spec.byte_offset, spec.count);
    }
    return { header, ...arrays };
  })();
  packetCache.set(url, pending);
  while (packetCache.size > 10) packetCache.delete(packetCache.keys().next().value);
  pending.catch(() => { if (packetCache.get(url) === pending) packetCache.delete(url); });
  return pending;
}
// Prepare the actual next observation without touching the visible surface,
// camera or selection. show() consumes these same decoded packets.
export async function preloadFrame(region, year, mode) {
  const spec = region.webgl;
  const url = spec?.frames?.[mode]?.find((frame) => Number(frame.year) === Number(year))?.url;
  if (!spec?.static_url || !url) throw new Error('3D frame unavailable');
  await Promise.all([packet(spec.static_url), packet(url)]);
}
function disposeGroup(group) {
  group.traverse((object) => { object.geometry?.dispose(); if (Array.isArray(object.material)) object.material.forEach((m) => m.dispose()); else object.material?.dispose(); });
  group.clear();
}
function lineGeometry(points, lengths, dimensions = 2, z = 0) {
  const segments = []; let cursor = 0;
  for (const count of lengths) {
    for (let i = 1; i < count; i++) {
      const a = (cursor + i - 1) * dimensions, b = (cursor + i) * dimensions;
      segments.push(points[a], points[a + 1], dimensions === 3 ? points[a + 2] : z, points[b], points[b + 1], dimensions === 3 ? points[b + 2] : z);
    }
    cursor += count;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(segments, 3));
  return geometry;
}
function charcoalGround() {
  // A restrained spatial light field, independent of the white studio IBL.
  // Canvas colors are explicitly sRGB so the dark stage matches the page.
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
  const context = canvas.getContext('2d'); context.fillStyle = '#080b10'; context.fillRect(0, 0, 1024, 1024);
  const lightPool = (x, y, radius, color) => {
    const cx = 512 + x * 1024 / 200, cy = 512 - y * 1024 / 200;
    const gradient = context.createRadialGradient(cx, cy, 0, cx, cy, radius * 1024 / 200);
    gradient.addColorStop(0, color); gradient.addColorStop(1, 'rgba(0,0,0,0)');
    context.fillStyle = gradient; context.fillRect(0, 0, 1024, 1024);
  };
  lightPool(-5, -9, 14, 'rgba(88,62,37,0.78)');
  lightPool(11, 2, 16, 'rgba(64,86,116,0.86)');
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function polygonGeometry(polygons) {
  const shapes = [];
  for (const polygon of polygons || []) {
    if (!polygon.outer || polygon.outer.length < 3) continue;
    const shape = new THREE.Shape(polygon.outer.map(([x, y]) => new THREE.Vector2(x, y)));
    for (const hole of polygon.holes || []) if (hole.length >= 3) shape.holes.push(new THREE.Path(hole.map(([x, y]) => new THREE.Vector2(x, y))));
    shapes.push(shape);
  }
  return shapes.length ? new THREE.ShapeGeometry(shapes) : null;
}

function missingTexture() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d'); context.clearRect(0, 0, 64, 64);
  context.strokeStyle = '#b1bbc4'; context.lineWidth = 3;
  for (let offset = -64; offset <= 64; offset += 16) {
    context.beginPath(); context.moveTo(offset, 0); context.lineTo(offset + 64, 64); context.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(1.8, 1.8);
  return texture;
}

// Sample only inside actual source triangles. Missing regions never acquire a
// nearest-neighbour height or a fabricated zero-valued relief.
function surfaceSampler(base, frame) {
  const xs = [], ys = [];
  for (let i = 0; i < base.xy.length; i += 2) { xs.push(base.xy[i]); ys.push(base.xy[i + 1]); }
  const uniqueX = [...new Set(xs)].sort((a, b) => a - b), uniqueY = [...new Set(ys)].sort((a, b) => a - b);
  const spacing = (values) => values.slice(1).reduce((step, value, i) => Math.min(step, value - values[i]), Infinity);
  const dx = spacing(uniqueX), dy = spacing(uniqueY), minX = uniqueX[0], minY = uniqueY[0];
  const stride = Math.round((uniqueX.at(-1) - minX) / dx) + 2, cells = new Map();
  const ix = xs.map((x) => Math.round((x - minX) / dx)), iy = ys.map((y) => Math.round((y - minY) / dy));
  const triangles = frame.triangles || (() => {
    const indices = [];
    for (let i = 0; i < base.faces.length; i += 4) indices.push(base.faces[i], base.faces[i + 1], base.faces[i + 2], base.faces[i], base.faces[i + 2], base.faces[i + 3]);
    return indices;
  })();
  for (let i = 0; i < triangles.length; i += 3) {
    const a = triangles[i], b = triangles[i + 1], c = triangles[i + 2];
    const key = Math.min(ix[a], ix[b], ix[c]) + Math.min(iy[a], iy[b], iy[c]) * stride;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(a, b, c);
  }
  return {
    step: Math.min(dx, dy),
    height(x, y) {
      const column = Math.floor((x - minX) / dx + 1e-8), row = Math.floor((y - minY) / dy + 1e-8);
      for (const [ox, oy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]]) {
        const indices = cells.get(column + ox + (row + oy) * stride); if (!indices) continue;
        for (let i = 0; i < indices.length; i += 3) {
          const a = indices[i], b = indices[i + 1], c = indices[i + 2];
          const determinant = (ys[b] - ys[c]) * (xs[a] - xs[c]) + (xs[c] - xs[b]) * (ys[a] - ys[c]);
          if (Math.abs(determinant) < 1e-14) continue;
          const u = ((ys[b] - ys[c]) * (x - xs[c]) + (xs[c] - xs[b]) * (y - ys[c])) / determinant;
          const v = ((ys[c] - ys[a]) * (x - xs[c]) + (xs[a] - xs[c]) * (y - ys[c])) / determinant;
          const w = 1 - u - v;
          if (u >= -1e-6 && v >= -1e-6 && w >= -1e-6) return u * frame.z[a] + v * frame.z[b] + w * frame.z[c];
        }
      }
      return null;
    },
  };
}

export class ReliefViewer {
  constructor(host, { onSelect, onError, onMove, onView } = {}) {
    this.host = host; this.onSelect = onSelect; this.onError = onError; this.onMove = onMove; this.onView = onView;
    this.active = true; this.dirty = true; this.contextLost = false; this.generation = 0; this.markersVisible = false; this.markerNodes = [];
    this.comparing = false; this.qualityVisible = false; this.interaction = null;
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping; this.renderer.toneMappingExposure = 1.24;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.VSMShadowMap;
    this.canvas = this.renderer.domElement; this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img'); this.canvas.setAttribute('aria-label', '회전 가능한 실제 야간광 입체. 방향키 회전, 더하기와 빼기 확대, R 원래 시점.');
    this.host.append(this.canvas);
    this.markerLayer = document.createElement('div'); this.markerLayer.className = 'webgl-markers'; this.host.append(this.markerLayer);
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color('#080b10'); this.scene.fog = new THREE.Fog('#080b10', 45, 95);
    this.camera = new THREE.OrthographicCamera(-9.25, 9.25, 5.203, -5.203, .1, 150); this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = !this.reduced.matches; this.controls.dampingFactor = .09;
    this.reduced.addEventListener('change', () => { this.controls.enableDamping = !this.reduced.matches; this.transition = null; this.dirty = true; });
    this.controls.minPolarAngle = .13; this.controls.maxPolarAngle = Math.PI * .49;
    this.controls.minZoom = .65; this.controls.maxZoom = 5; this.controls.rotateSpeed = .7; this.controls.zoomSpeed = .8;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => { this.dirty = true; });
    this.controls.addEventListener('start', () => { this.transition = null; this.onMove?.(); });
    const pmrem = new THREE.PMREMGenerator(this.renderer), room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, .04).texture; this.scene.environment = this.environment; room.dispose(); pmrem.dispose();
    // Broad studio reflections reveal the relief without lifting the ground.
    // Each material has its own reflection strength; the charcoal stage is unlit.
    this.scene.environmentIntensity = .09;
    this.scene.add(new THREE.HemisphereLight(0xaabbd0, 0x34281c, .55));
    const light = (color, intensity, position, shadows = false) => {
      const item = new THREE.DirectionalLight(color, intensity); item.position.set(...position); item.castShadow = shadows;
      if (shadows) { item.shadow.mapSize.set(1024, 1024); Object.assign(item.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: .1, far: 40 }); item.shadow.bias = -.0003; item.shadow.normalBias = .025; item.shadow.radius = 8; item.shadow.blurSamples = 12; }
      this.scene.add(item); this.scene.add(item.target);
    };
    light(0xffd4a3, 3.3, [-5, -1, 9], true);
    light(0x97bbef, 2.7, [2, 7, 8]);
    light(0xffd9a6, 2.5, [6, 1, 5]);
    light(0xe8edf5, .9, [-1, -8, 6]);
    this.fixed = new THREE.Group(); this.dynamic = new THREE.Group(); this.secondary = new THREE.Group();
    this.quality = new THREE.Group(); this.selection = new THREE.Group(); this.secondarySelection = new THREE.Group();
    this.scene.add(this.fixed, this.dynamic, this.secondary, this.quality, this.selection, this.secondarySelection);
    this.secondary.visible = this.secondarySelection.visible = false; this.quality.visible = false;
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshBasicMaterial({ map: charcoalGround(), toneMapped: false, dithering: true }));
    this.floorShadow = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ color: 0x000000, opacity: .42, depthWrite: false }));
    this.floorShadow.receiveShadow = true; this.scene.add(this.floor, this.floorShadow);
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(this.host);
    this.canvas.addEventListener('keydown', (event) => this.key(event));
    this.canvas.addEventListener('webglcontextlost', (event) => { event.preventDefault(); this.contextLost = true; this.active = false; ++this.generation; this.onError?.(new Error('WebGL context lost')); });
    this.renderer.setAnimationLoop((time) => {
      if (!this.active || document.hidden) return;
      if (this.transition) {
        const t = Math.min(1, (time - this.transition.start) / 550), eased = 1 - Math.pow(1 - t, 3), move = this.transition;
        this.camera.position.lerpVectors(move.fromPosition, move.toPosition, eased);
        this.controls.target.lerpVectors(move.fromTarget, move.toTarget, eased);
        this.camera.zoom = THREE.MathUtils.lerp(move.fromZoom, move.toZoom, eased); this.camera.updateProjectionMatrix();
        this.dirty = true; if (t === 1) this.transition = null;
      }
      this.controls.update();
      if (this.dirty) { this.renderViews(); this.projectMarkers(); this.reportView(); this.dirty = false; }
    });
  }
  resize() {
    const width = this.host.clientWidth, height = this.host.clientHeight; if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.comparisonAxis = width < 640 ? 'vertical' : 'horizontal';
    const paneWidth = this.comparing && this.comparisonAxis === 'horizontal' ? width / 2 : width;
    const paneHeight = this.comparing && this.comparisonAxis === 'vertical' ? height / 2 : height;
    const baseWidth = this.spec?.camera?.ortho_width || 18.5;
    // Wider windows retain the original 16:9 vertical field instead of cropping
    // tall peaks or outlying islands. Both comparison panes share this framing.
    const cameraWidth = baseWidth * Math.max(1, (paneWidth / paneHeight) / (16 / 9));
    const halfHeight = cameraWidth * paneHeight / paneWidth / 2;
    const shift = this.spec?.camera?.shift_y || 0;
    this.camera.left = -cameraWidth / 2; this.camera.right = cameraWidth / 2;
    this.camera.top = halfHeight + cameraWidth * shift; this.camera.bottom = -halfHeight + cameraWidth * shift;
    this.camera.updateProjectionMatrix(); this.dirty = true;
  }
  panes() {
    if (!this.comparing) return [{ left: 0, top: 0, width: 1, height: 1 }];
    return this.comparisonAxis === 'vertical'
      ? [{ left: 0, top: 0, width: 1, height: .5 }, { left: 0, top: .5, width: 1, height: .5 }]
      : [{ left: 0, top: 0, width: .5, height: 1 }, { left: .5, top: 0, width: .5, height: 1 }];
  }
  renderViews() {
    const width = this.host.clientWidth, height = this.host.clientHeight;
    this.renderer.setScissorTest(this.comparing);
    for (const [index, pane] of this.panes().entries()) {
      const x = pane.left * width, y = (1 - pane.top - pane.height) * height;
      this.renderer.setViewport(x, y, pane.width * width, pane.height * height);
      this.renderer.setScissor(x, y, pane.width * width, pane.height * height);
      this.dynamic.visible = this.selection.visible = index === 0;
      this.secondary.visible = this.secondarySelection.visible = index === 1;
      // Both observations use this exact camera, lighting, and original height
      // scale. Scissoring needs only one WebGL context and one set of controls.
      this.renderer.render(this.scene, this.camera);
    }
    this.renderer.setScissorTest(false); this.renderer.setViewport(0, 0, width, height);
    this.dynamic.visible = this.selection.visible = true;
    this.secondary.visible = this.secondarySelection.visible = false;
  }
  reportView() {
    const center = this.controls.target.clone().project(this.camera);
    const north = this.controls.target.clone().add(new THREE.Vector3(0, 1, 0)).project(this.camera);
    const pane = this.panes()[0];
    const dx = (north.x - center.x) * this.host.clientWidth * pane.width;
    const dy = (north.y - center.y) * this.host.clientHeight * pane.height;
    this.onView?.({ northAngle: Math.atan2(dx, dy) * 180 / Math.PI, comparing: this.comparing, comparisonAxis: this.comparisonAxis, qualityAvailable: !!this.interaction?.missing });
  }
  async show(region, year, mode, { compareYear, interaction } = {}) {
    if (this.contextLost) throw new Error('Reload required after WebGL context loss');
    const generation = ++this.generation, spec = region.webgl;
    if (!spec) throw new Error('3D geometry not available');
    const comparing = compareYear !== undefined && compareYear !== null;
    if (comparing) mode = 'absolute';
    const frameURL = spec.frames?.[mode]?.find((f) => Number(f.year) === Number(year))?.url;
    if (!frameURL) throw new Error('3D frame unavailable');
    const secondURL = comparing && spec.frames?.absolute?.find((f) => Number(f.year) === Number(compareYear))?.url;
    if (comparing && !secondURL) throw new Error('Comparison observation unavailable');
    const [base, frame, secondFrame, location] = await Promise.all([
      packet(spec.static_url), packet(frameURL), comparing ? packet(secondURL) : null,
      interaction === undefined ? interactionData(region.interaction_url).catch(() => null) : interaction,
    ]);
    if (this.contextLost) throw new Error('Reload required after WebGL context loss');
    if (generation !== this.generation) return false;
    if (!base.xy || !frame.z || frame.z.length * 2 !== base.xy.length) throw new Error('Geometry dimensions do not match');
    if (secondFrame && secondFrame.z.length * 2 !== base.xy.length) throw new Error('Comparison geometry dimensions do not match');
    const regionChanged = this.regionId !== region.id, modeChanged = this.mode !== mode, baseChanged = this.base !== base || this.spec?.static_url !== spec.static_url;
    this.spec = spec; this.base = base; this.frame = frame; this.secondFrame = secondFrame;
    this.region = region; this.regionId = region.id; this.mode = mode; this.comparing = comparing; this.year = year; this.compareYear = compareYear;
    this.sampler = surfaceSampler(base, frame); this.secondSampler = secondFrame ? surfaceSampler(base, secondFrame) : null;
    if (regionChanged || modeChanged || baseChanged) this.buildFixed(base, mode);
    this.buildSurface(this.dynamic, base, frame);
    disposeGroup(this.secondary); if (secondFrame) this.buildSurface(this.secondary, base, secondFrame);
    this.setInteraction(location);
    this.canvas.setAttribute('aria-label', comparing
      ? `${year}년과 ${compareYear}년 실제 야간광 입체 비교. 두 시점이 함께 회전합니다. 방향키 회전, 더하기와 빼기 확대, R 원래 시점.`
      : `${year}년 실제 야간광 입체. 방향키 회전, 더하기와 빼기 확대, R 원래 시점.`);
    this.makeMarkers(region); this.resize(); if (regionChanged) this.reset(false); this.dirty = true; return true;
  }
  buildSurface(group, base, frame) {
    disposeGroup(group);
    const positions = new Float32Array(frame.z.length * 3);
    for (let i = 0; i < frame.z.length; i++) { positions[i * 3] = base.xy[i * 2]; positions[i * 3 + 1] = base.xy[i * 2 + 1]; positions[i * 3 + 2] = frame.z[i]; }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    if (frame.triangles) geometry.setIndex(new THREE.BufferAttribute(frame.triangles, 1));
    else { const triangles = []; for (let i = 0; i < base.faces.length; i += 4) triangles.push(base.faces[i], base.faces[i + 1], base.faces[i + 2], base.faces[i], base.faces[i + 2], base.faces[i + 3]); geometry.setIndex(triangles); }
    if (frame.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(frame.normals), 3)); else geometry.computeVertexNormals();
    const body = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: new THREE.Color(.04, .027, .016), metalness: .68, roughness: .34, envMap: this.environment, envMapIntensity: .09, side: THREE.DoubleSide }));
    body.castShadow = true; body.receiveShadow = true; group.add(body);
    if (frame.p?.length && frame.n?.length) {
      // Preserve the observed contour centerlines; world-space width gives them
      // the fine filament volume of the original Blender curves while orbiting.
      const centerlines = lineGeometry(frame.p, frame.n, 3);
      const contourGeometry = new LineSegmentsGeometry().setPositions(centerlines.getAttribute('position').array);
      centerlines.dispose();
      const colors = []; let line = 0;
      for (const count of frame.n) {
        const level = frame.levels[line++], t = Math.min(1, Math.abs(level) / 4.2);
        const color = level < 0 ? [.28 + .42 * t, .55 + .37 * t, .9 + .1 * t] : [.62 + .35 * t, .31 + .59 * t, .095 + .60 * t];
        for (let i = 1; i < count; i++) colors.push(...color, ...color);
      }
      contourGeometry.setColors(colors);
      const contours = new LineSegments2(contourGeometry, new LineMaterial({ vertexColors: true, worldUnits: true, linewidth: .018, alphaToCoverage: true, toneMapped: false, depthWrite: false }));
      contours.renderOrder = 2; group.add(contours);
    }
  }
  buildFixed(base, mode) {
    disposeGroup(this.fixed); const absolute = mode === 'absolute'; this.floor.position.z = absolute ? -1.1 : -2.6; this.floorShadow.position.z = this.floor.position.z + .002;
    const addLines = (points, lengths, color, z, opacity = 1) => { if (!points || !lengths) return; this.fixed.add(new THREE.LineSegments(lineGeometry(points, lengths, 2, z), new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, toneMapped: false }))); };
    addLines(base.outline_points, base.outline_lengths, absolute ? 0x997a4c : 0x607e95, absolute ? -.06 : 0);
    addLines(base.district_points, base.district_lengths, 0x536979, absolute ? -.059 : -.004, .48);
    if (absolute && (base.base_positions || base.base)) {
      const geometry = new THREE.BufferGeometry();
      if (base.base_positions) { geometry.setAttribute('position', new THREE.Float32BufferAttribute(base.base_positions, 3)); if (base.base_triangles) geometry.setIndex(new THREE.BufferAttribute(base.base_triangles, 1)); if (base.base_normals) geometry.setAttribute('normal', new THREE.Float32BufferAttribute(base.base_normals, 3)); else geometry.computeVertexNormals(); }
      else { const positions = []; for (let i = 0; i < base.base.length; i += 2) positions.push(base.base[i], base.base[i + 1], -.065); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.computeVertexNormals(); }
      const plate = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: new THREE.Color(.017, .022, .029), metalness: .65, roughness: .43, envMap: this.environment, envMapIntensity: .025, flatShading: true, side: THREE.DoubleSide })); plate.castShadow = true; plate.receiveShadow = true; this.fixed.add(plate);
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const extent = base.base || base.xy;
    for (let i = 0; i < extent.length; i += 2) { minX = Math.min(minX, extent[i]); maxX = Math.max(maxX, extent[i]); minY = Math.min(minY, extent[i + 1]); maxY = Math.max(maxY, extent[i + 1]); }
    addLines(new Float32Array([minX,minY,maxX,minY,maxX,maxY,minX,maxY,minX,minY]), [5], absolute ? 0x725737 : 0x42596c, -.12, .75);
    addLines(new Float32Array([minX+.3,maxY-.75,minX+.3,maxY-.2,minX+.2,maxY-.35,minX+.3,maxY-.2,minX+.4,maxY-.35]), [2,3], 0x738894, -.11);
  }
  makeMarkers(region) {
    this.markerLayer.replaceChildren(); this.markerNodes = [];
    for (const [pane, sampler] of (this.comparing ? [this.sampler, this.secondSampler] : [this.sampler]).entries()) {
      for (const anchor of this.spec.district_anchors || []) {
        const district = region.districts.find((d) => String(d.id) === String(anchor.id)); if (!district) continue;
        const height = sampler.height(anchor.xyz[0], anchor.xyz[1]);
        const position = new THREE.Vector3(anchor.xyz[0], anchor.xyz[1], (height ?? anchor.xyz[2] ?? 0) + .09);
        const button = document.createElement('button'); button.type = 'button'; button.className = 'hotspot'; button.hidden = true;
        button.setAttribute('aria-label', `${this.comparing ? `${pane ? this.compareYear : this.year}년 관측, ` : ''}${district.name} 중심으로 이동 및 정보`);
        const name = document.createElement('span'); name.textContent = district.name; button.append(name); button.addEventListener('click', () => this.onSelect?.(String(district.id))); this.markerLayer.append(button);
        this.markerNodes.push({ id: String(district.id), position, button, pane });
      }
    }
    this.select(this.selected); this.setMarkersVisible(this.markersVisible);
  }
  projectMarkers() {
    const panes = this.panes();
    let anyVisible = false;
    for (const item of this.markerNodes) {
      const p = item.position.clone().project(this.camera), pane = panes[item.pane];
      const allowed = this.markersVisible || item.id === this.selected;
      const visible = allowed && pane && p.z >= -1 && p.z <= 1 && Math.abs(p.x) < .99 && Math.abs(p.y) < .99;
      item.button.hidden = !visible;
      anyVisible ||= !!visible;
      if (pane) { item.button.style.left = `${100 * (pane.left + (p.x + 1) / 2 * pane.width)}%`; item.button.style.top = `${100 * (pane.top + (1 - p.y) / 2 * pane.height)}%`; }
    }
    // "All markers" off still retains the selected district in each pane.
    // Hidden markers also leave keyboard navigation, not just the painting.
    this.markerLayer.hidden = !anyVisible;
  }
  setInteraction(interaction) {
    this.interaction = interaction;
    disposeGroup(this.quality);
    const geometry = polygonGeometry(interaction?.missing);
    if (geometry) {
      this.qualityTexture ||= missingTexture();
      const hatch = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: this.qualityTexture, transparent: true, opacity: .38, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
      // This flat hatch is a footprint on the reference plane, never a height
      // value. Measured zero-valued cells remain part of the observed surface.
      hatch.position.z = .032; hatch.renderOrder = 3; this.quality.add(hatch);
    }
    this.quality.visible = this.qualityVisible;
    this.buildSelection(this.selection, this.sampler); this.buildSelection(this.secondarySelection, this.secondSampler);
    this.dirty = true;
  }
  buildSelection(group, sampler) {
    disposeGroup(group); if (!sampler || !this.selected) return;
    const district = this.interaction?.districts?.find((entry) => String(entry.id) === this.selected); if (!district) return;
    const observed = [], missing = [], footprint = [];
    for (const polygon of district.polygons || []) {
      for (const ring of [polygon.outer, ...(polygon.holes || [])]) {
        if (!ring?.length) continue;
        for (let i = 1; i <= ring.length; i++) {
          const a = ring[i - 1], b = ring[i % ring.length], distance = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (distance < 1e-9) continue;
          footprint.push(a[0], a[1], .024, b[0], b[1], .024);
          const steps = Math.max(1, Math.ceil(distance / (sampler.step * .5)));
          let x = a[0], y = a[1], z = sampler.height(x, y);
          for (let j = 1; j <= steps; j++) {
            const nx = a[0] + (b[0] - a[0]) * j / steps, ny = a[1] + (b[1] - a[1]) * j / steps, nz = sampler.height(nx, ny);
            if (z !== null && nz !== null) observed.push(x, y, z + .034, nx, ny, nz + .034);
            else missing.push(x, y, .038, nx, ny, .038);
            x = nx; y = ny; z = nz;
          }
        }
      }
    }
    const referenceGeometry = new THREE.BufferGeometry(); referenceGeometry.setAttribute('position', new THREE.Float32BufferAttribute(footprint, 3));
    group.add(new THREE.LineSegments(referenceGeometry, new THREE.LineBasicMaterial({ color: 0x91b5c3, transparent: true, opacity: .28, depthWrite: false, toneMapped: false })));
    if (observed.length) {
      const geometry = new LineSegmentsGeometry().setPositions(observed);
      const boundary = new LineSegments2(geometry, new LineMaterial({ color: 0xb8dde5, worldUnits: true, linewidth: .029, transparent: true, opacity: .88, alphaToCoverage: true, toneMapped: false, depthWrite: false }));
      boundary.renderOrder = 4; group.add(boundary);
    }
    if (missing.length) {
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(missing, 3));
      const distances = []; let cursor = 0;
      for (let i = 0; i < missing.length; i += 6) { distances.push(cursor); cursor += Math.hypot(missing[i + 3] - missing[i], missing[i + 4] - missing[i + 1]); distances.push(cursor); }
      geometry.setAttribute('lineDistance', new THREE.Float32BufferAttribute(distances, 1));
      const boundary = new THREE.LineSegments(geometry, new THREE.LineDashedMaterial({ color: 0xaab9c2, transparent: true, opacity: .7, dashSize: .07, gapSize: .05, depthWrite: false, toneMapped: false }));
      boundary.renderOrder = 4; group.add(boundary);
    }
  }
  select(id) {
    this.selected = id ? String(id) : null;
    for (const item of this.markerNodes) { const active = item.id === this.selected; item.button.classList.toggle('selected', active); item.button.setAttribute('aria-pressed', String(active)); }
    this.buildSelection(this.selection, this.sampler); this.buildSelection(this.secondarySelection, this.secondSampler); this.projectMarkers(); this.dirty = true;
  }
  focus(id) {
    this.select(id); const point = this.markerNodes.find((item) => item.id === String(id)); if (!point) return;
    const offset = this.camera.position.clone().sub(this.controls.target), target = point.position.clone(); this.move(target.clone().add(offset), target, Math.max(1.8, this.camera.zoom), true);
  }
  move(position, target, zoom, animate) {
    if (animate && !this.reduced.matches) this.transition = { start: performance.now(), fromPosition: this.camera.position.clone(), toPosition: position, fromTarget: this.controls.target.clone(), toTarget: target, fromZoom: this.camera.zoom, toZoom: zoom };
    else { this.transition = null; this.camera.position.copy(position); this.controls.target.copy(target); this.camera.zoom = zoom; this.camera.updateProjectionMatrix(); this.controls.update(); }
    this.dirty = true;
  }
  reset(animate = true) {
    const camera = this.spec?.camera || {}; this.move(new THREE.Vector3(...(camera.position || [11,-16,19])), new THREE.Vector3(...(camera.target_by_mode?.[this.mode] || [0,0,0])), 1.16, animate); this.onMove?.(false);
  }
  action(name) {
    this.transition = null;
    if (name === 'left') this.controls.rotateLeft(.18);
    if (name === 'right') this.controls.rotateLeft(-.18);
    if (name === 'up') this.controls.rotateUp(.12);
    if (name === 'down') this.controls.rotateUp(-.12);
    if (name === 'in') this.controls.dollyIn(.8);
    if (name === 'out') this.controls.dollyOut(.8);
    if (name === 'reset') this.reset();
    this.controls.update(); this.dirty = true;
  }
  key(event) {
    const action = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', '+': 'in', '=': 'in', '-': 'out', _: 'out', r: 'reset', R: 'reset' }[event.key];
    if (action) { event.preventDefault(); this.action(action); }
  }
  setMarkersVisible(visible) { this.markersVisible = !!visible; this.projectMarkers(); this.dirty = true; }
  setQualityVisible(visible) { this.qualityVisible = !!visible; this.quality.visible = this.qualityVisible; this.dirty = true; }
  setActive(active) { this.active = active && !this.contextLost; if (this.active) { this.resize(); this.dirty = true; } }
}
