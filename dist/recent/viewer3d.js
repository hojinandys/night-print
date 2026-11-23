import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';

// Three.js 0.187.0, distributed locally under the included MIT license.
// Geometry packets preserve the original Blender display geometry; values are never inferred from images.
const packetCache = new Map();
async function packet(url) {
  if (packetCache.has(url)) return packetCache.get(url);
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
  pending.catch(() => packetCache.delete(url));
  return pending;
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
  lightPool(-7, -3, 23, 'rgba(42,26,16,0.38)');
  lightPool(6, 5, 24, 'rgba(18,33,49,0.35)');
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class ReliefViewer {
  constructor(host, { onSelect, onError, onMove } = {}) {
    this.host = host; this.onSelect = onSelect; this.onError = onError; this.onMove = onMove;
    this.active = true; this.dirty = true; this.generation = 0; this.markersVisible = true; this.markerNodes = [];
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping; this.renderer.toneMappingExposure = .95;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFShadowMap;
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
    // RoomEnvironment contains very bright white studio panels. Keep their
    // reflection faint so the sculpture retains its original dark bronze.
    this.scene.environmentIntensity = .025;
    this.scene.add(new THREE.HemisphereLight(0x6e87aa, 0x19120c, .35));
    const light = (color, intensity, position, shadows = false) => {
      const item = new THREE.DirectionalLight(color, intensity); item.position.set(...position); item.castShadow = shadows;
      if (shadows) { item.shadow.mapSize.set(1024, 1024); Object.assign(item.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: .1, far: 40 }); item.shadow.bias = -.0003; item.shadow.normalBias = .025; item.shadow.radius = 10; }
      this.scene.add(item); this.scene.add(item.target);
    };
    light(0xffb06e, 2.4, [-5, -1, 9], true); light(0x6b9cff, 1.3, [2, 7, 8]); light(0xffcc94, 1.6, [6, 1, 5]);
    this.fixed = new THREE.Group(); this.dynamic = new THREE.Group(); this.scene.add(this.fixed, this.dynamic);
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshBasicMaterial({ map: charcoalGround(), toneMapped: false, dithering: true }));
    this.floorShadow = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ color: 0x000000, opacity: .26, depthWrite: false }));
    this.floorShadow.receiveShadow = true; this.scene.add(this.floor, this.floorShadow);
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(this.host);
    this.canvas.addEventListener('keydown', (event) => this.key(event));
    this.canvas.addEventListener('webglcontextlost', (event) => { event.preventDefault(); this.active = false; this.onError?.(new Error('WebGL context lost')); });
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
      if (this.dirty) { this.renderer.render(this.scene, this.camera); this.projectMarkers(); this.dirty = false; }
    });
  }
  resize() {
    const width = this.host.clientWidth, height = this.host.clientHeight; if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    const cameraWidth = this.spec?.camera?.ortho_width || 18.5, halfHeight = cameraWidth * height / width / 2;
    const shift = this.spec?.camera?.shift_y || 0;
    this.camera.left = -cameraWidth / 2; this.camera.right = cameraWidth / 2;
    this.camera.top = halfHeight + cameraWidth * shift; this.camera.bottom = -halfHeight + cameraWidth * shift;
    this.camera.updateProjectionMatrix(); this.dirty = true;
  }
  async show(region, year, mode) {
    const generation = ++this.generation, spec = region.webgl;
    if (!spec) throw new Error('3D geometry not available');
    const frameURL = spec.frames?.[mode]?.find((f) => Number(f.year) === Number(year))?.url;
    if (!frameURL) throw new Error('3D frame unavailable');
    const [base, frame] = await Promise.all([packet(spec.static_url), packet(frameURL)]);
    if (generation !== this.generation) return false;
    if (!base.xy || !frame.z || frame.z.length * 2 !== base.xy.length) throw new Error('Geometry dimensions do not match');
    const regionChanged = this.regionId !== region.id, modeChanged = this.mode !== mode;
    this.spec = spec; this.base = base; this.frame = frame; this.regionId = region.id; this.mode = mode;
    if (regionChanged || modeChanged) this.buildFixed(base, mode);
    disposeGroup(this.dynamic);
    const positions = new Float32Array(frame.z.length * 3);
    for (let i = 0; i < frame.z.length; i++) { positions[i * 3] = base.xy[i * 2]; positions[i * 3 + 1] = base.xy[i * 2 + 1]; positions[i * 3 + 2] = frame.z[i]; }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    if (frame.triangles) geometry.setIndex(new THREE.BufferAttribute(frame.triangles, 1));
    else { const triangles = []; for (let i = 0; i < base.faces.length; i += 4) triangles.push(base.faces[i], base.faces[i + 1], base.faces[i + 2], base.faces[i], base.faces[i + 2], base.faces[i + 3]); geometry.setIndex(triangles); }
    if (frame.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(frame.normals), 3)); else geometry.computeVertexNormals();
    const body = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: new THREE.Color(.028, .019, .012), metalness: .72, roughness: .4, envMap: this.environment, envMapIntensity: .025, side: THREE.DoubleSide }));
    body.castShadow = true; body.receiveShadow = true; this.dynamic.add(body);
    if (frame.p && frame.n) {
      const contourGeometry = lineGeometry(frame.p, frame.n, 3), colors = []; let line = 0;
      for (const count of frame.n) {
        const level = frame.levels[line++], t = Math.min(1, Math.abs(level) / 4.2);
        const color = level < 0 ? [.16 + .5 * t, .38 + .48 * t, .64 + .32 * t] : [.4 + .5 * t, .16 + .65 * t, .045 + .51 * t];
        for (let i = 1; i < count; i++) colors.push(...color, ...color);
      }
      contourGeometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const contours = new THREE.LineSegments(contourGeometry, new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false, transparent: true, opacity: .95, depthWrite: false }));
      contours.renderOrder = 2; this.dynamic.add(contours);
    }
    this.makeMarkers(region); this.resize(); if (regionChanged) this.reset(false); this.dirty = true; return true;
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
      const plate = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: new THREE.Color(.017, .022, .029), metalness: .45, roughness: .62, envMap: this.environment, envMapIntensity: .012, flatShading: true, side: THREE.DoubleSide })); plate.castShadow = true; plate.receiveShadow = true; this.fixed.add(plate);
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const extent = base.base || base.xy;
    for (let i = 0; i < extent.length; i += 2) { minX = Math.min(minX, extent[i]); maxX = Math.max(maxX, extent[i]); minY = Math.min(minY, extent[i + 1]); maxY = Math.max(maxY, extent[i + 1]); }
    addLines(new Float32Array([minX,minY,maxX,minY,maxX,maxY,minX,maxY,minX,minY]), [5], absolute ? 0x725737 : 0x42596c, -.12, .75);
    addLines(new Float32Array([minX+.3,maxY-.75,minX+.3,maxY-.2,minX+.2,maxY-.35,minX+.3,maxY-.2,minX+.4,maxY-.35]), [2,3], 0x738894, -.11);
  }
  makeMarkers(region) {
    this.markerLayer.replaceChildren(); this.markerNodes = [];
    for (const anchor of this.spec.district_anchors || []) {
      const district = region.districts.find((d) => String(d.id) === String(anchor.id)); if (!district) continue;
      let nearest = 0, distance = Infinity;
      for (let i = 0; i < this.base.xy.length; i += 2) { const d = (this.base.xy[i] - anchor.xyz[0]) ** 2 + (this.base.xy[i + 1] - anchor.xyz[1]) ** 2; if (d < distance) { distance = d; nearest = i / 2; } }
      const position = new THREE.Vector3(anchor.xyz[0], anchor.xyz[1], Math.max(anchor.xyz[2] || 0, this.frame.z[nearest]) + .09);
      const button = document.createElement('button'); button.type = 'button'; button.className = 'hotspot'; button.setAttribute('aria-label', `${district.name} 중심으로 이동 및 정보`);
      const name = document.createElement('span'); name.textContent = district.name; button.append(name); button.addEventListener('click', () => this.onSelect?.(String(district.id))); this.markerLayer.append(button);
      this.markerNodes.push({ id: String(district.id), position, button });
    }
    this.select(this.selected); this.setMarkersVisible(this.markersVisible);
  }
  projectMarkers() {
    for (const item of this.markerNodes) { const p = item.position.clone().project(this.camera), visible = p.z >= -1 && p.z <= 1 && Math.abs(p.x) < 1.02 && Math.abs(p.y) < 1.02; item.button.hidden = !visible; item.button.style.left = `${(p.x + 1) * 50}%`; item.button.style.top = `${(1 - p.y) * 50}%`; }
  }
  select(id) { this.selected = id ? String(id) : null; for (const item of this.markerNodes) { const active = item.id === this.selected; item.button.classList.toggle('selected', active); item.button.setAttribute('aria-pressed', String(active)); } this.dirty = true; }
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
  setMarkersVisible(visible) { this.markersVisible = visible; this.markerLayer.hidden = !visible; }
  setActive(active) { this.active = active; if (active) { this.resize(); this.dirty = true; } }
}
