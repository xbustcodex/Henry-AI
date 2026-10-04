/**
 * Henry 3D Model Preview — WebGL viewer using Three.js
 * Renders the generated STL geometry with orbit controls
 * Tap/drag to rotate, pinch to zoom, shows real dimensions
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';

interface Triangle {
  a: { x: number; y: number; z: number };
  b: { x: number; y: number; z: number };
  c: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
}

interface Props {
  triangles: Triangle[];
  name?: string;
  className?: string;
}

export default function ModelPreview3D({ triangles, name, className = '' }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
   
  const sceneRef = useRef<any>(null);

  useEffect(() => {
    const el = mountRef.current;
    if (!el || triangles.length === 0) return;

    const w = el.clientWidth;
    const h = el.clientHeight;

    // Scene
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f0f18);

    // Camera
    const camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 10000);

    // Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(w, h);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    el.appendChild(renderer.domElement);

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.4);
    scene.add(ambient);
    const dir1 = new THREE.DirectionalLight(0xffffff, 0.8);
    dir1.position.set(1, 2, 1);
    scene.add(dir1);
    const dir2 = new THREE.DirectionalLight(0x6366f1, 0.3);
    dir2.position.set(-1, -1, 2);
    scene.add(dir2);

    // Grid
    const grid = new THREE.GridHelper(300, 30, 0x1a1a28, 0x1a1a28);
    scene.add(grid);

    // Build geometry from triangles
    const geom = new THREE.BufferGeometry();
    const positions: number[] = [];
    const normals: number[] = [];

    for (const t of triangles) {
      for (const v of [t.a, t.b, t.c]) {
        positions.push(v.x, v.z, -v.y); // reorient Y-up
        normals.push(t.normal.x, t.normal.z, -t.normal.y);
      }
    }

    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geom.computeBoundingBox();

    const mat = new THREE.MeshPhongMaterial({
      color: 0x6366f1,
      specular: 0x222244,
      shininess: 40,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geom, mat);

    // Center on grid
    const bbox = new THREE.Box3().setFromObject(mesh);
    const center = new THREE.Vector3();
    bbox.getCenter(center);
    const size = new THREE.Vector3();
    bbox.getSize(size);
    mesh.position.sub(center);
    mesh.position.y += size.y / 2;
    scene.add(mesh);

    // Fit camera
    const maxDim = Math.max(size.x, size.y, size.z);
    const radius = maxDim * 1.8;
    const spherical = { theta: Math.PI / 4, phi: Math.PI / 3.5, radius };
    updateCamera(camera, spherical);

    // Axes helper
    const axes = new THREE.AxesHelper(maxDim * 0.3);
    scene.add(axes);

    // Animate
    let animId = 0;
    const animate = () => {
      animId = requestAnimationFrame(animate);
      renderer.render(scene, camera);
    };
    animate();

    // Interaction state
    let isDragging = false;
    let lastMouse = { x: 0, y: 0 };
    let touchDist = 0;

    const onMouseDown = (e: MouseEvent) => { isDragging = true; lastMouse = { x: e.clientX, y: e.clientY }; };
    const onMouseUp = () => { isDragging = false; };
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const dx = (e.clientX - lastMouse.x) * 0.01;
      const dy = (e.clientY - lastMouse.y) * 0.01;
      spherical.theta -= dx;
      spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, spherical.phi + dy));
      updateCamera(camera, spherical);
      lastMouse = { x: e.clientX, y: e.clientY };
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      spherical.radius = Math.max(maxDim * 0.5, Math.min(maxDim * 5, spherical.radius + e.deltaY * 0.3));
      updateCamera(camera, spherical);
    };

    // Touch
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 1) { isDragging = true; lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }
      if (e.touches.length === 2) { touchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY); }
    };
    const onTouchEnd = () => { isDragging = false; };
    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 1 && isDragging) {
        const dx = (e.touches[0].clientX - lastMouse.x) * 0.01;
        const dy = (e.touches[0].clientY - lastMouse.y) * 0.01;
        spherical.theta -= dx;
        spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, spherical.phi + dy));
        updateCamera(camera, spherical);
        lastMouse = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      }
      if (e.touches.length === 2) {
        const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        spherical.radius = Math.max(maxDim * 0.5, Math.min(maxDim * 5, spherical.radius * (touchDist / dist)));
        touchDist = dist;
        updateCamera(camera, spherical);
      }
    };

    const canvas = renderer.domElement;
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('touchstart', onTouchStart, { passive: true });
    canvas.addEventListener('touchend', onTouchEnd);
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });

    sceneRef.current = { renderer, scene, camera, mesh, animId, isDragging, lastMouse, spherical, touchDist };

    return () => {
      cancelAnimationFrame(animId);
      canvas.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('touchmove', onTouchMove);
      renderer.dispose();
      if (el.contains(canvas)) el.removeChild(canvas);
    };
  }, [triangles]);

  return (
    <div className={`relative rounded-xl overflow-hidden border border-henry-border/30 bg-[#0f0f18] ${className}`}>
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />
      <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between pointer-events-none">
        <span className="text-[10px] text-henry-text-muted/60 bg-black/30 px-2 py-0.5 rounded">
          {name || '3D Model'} · {triangles.length.toLocaleString()} triangles
        </span>
        <span className="text-[10px] text-henry-text-muted/60 bg-black/30 px-2 py-0.5 rounded">
          Drag to rotate · Scroll to zoom
        </span>
      </div>
    </div>
  );
}

 
function updateCamera(camera: any, s: { theta: number; phi: number; radius: number }) {
  camera.position.set(
    s.radius * Math.sin(s.phi) * Math.sin(s.theta),
    s.radius * Math.cos(s.phi),
    s.radius * Math.sin(s.phi) * Math.cos(s.theta)
  );
  camera.lookAt(0, 0, 0);
}
