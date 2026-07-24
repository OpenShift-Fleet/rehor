import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { EmbeddingPoint, Memory } from '../types';
import { fetchEmbeddings, fetchMemory } from '../api';
import DetailPanel from '../components/DetailPanel';
import { deleteMemory } from '../api';

const CATEGORY_COLORS: Record<string, number> = {
  learning: 0x3fb950,
  review_feedback: 0xd29922,
  codebase_pattern: 0x58a6ff,
};

const SPREAD = 2.5;
const CONNECT_DISTANCE = 0.6;

export default function EmbeddingMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [selectedMemory, setSelectedMemory] = useState<Memory | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const handleDelete = async (id: number) => {
    await deleteMemory(id);
    setSelectedMemory(null);
  };

  useEffect(() => {
    const container = containerRef.current;
    const tooltip = tooltipRef.current;
    if (!container || !tooltip) return;

    let disposed = false;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x161b22);

    const camera = new THREE.PerspectiveCamera(
      60,
      container.clientWidth / container.clientHeight,
      0.1,
      1000
    );
    camera.position.set(3, 3, 3);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    // Grid and axes
    const grid = new THREE.GridHelper(10, 20, 0x30363d, 0x21262d);
    scene.add(grid);

    const axisLen = 2;
    const axisColors = [0xff4444, 0x44ff44, 0x4444ff];
    const axisDirections = [
      new THREE.Vector3(axisLen, 0, 0),
      new THREE.Vector3(0, axisLen, 0),
      new THREE.Vector3(0, 0, axisLen),
    ];
    axisDirections.forEach((dir, i) => {
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        dir,
      ]);
      const mat = new THREE.LineBasicMaterial({ color: axisColors[i], opacity: 0.3, transparent: true });
      scene.add(new THREE.Line(geo, mat));
    });

    // Raycaster
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    let hoveredIndex = -1;
    const spheres: THREE.Mesh[] = [];
    const pointData: EmbeddingPoint[] = [];
    const originalColors: THREE.Color[] = [];

    const onMouseMove = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(spheres);

      if (intersects.length > 0) {
        const idx = spheres.indexOf(intersects[0].object as THREE.Mesh);
        if (idx !== hoveredIndex) {
          hoveredIndex = idx;
          const pt = pointData[idx];
          tooltip.style.display = 'block';
          tooltip.innerHTML = `<strong>${pt.title}</strong><br/><span class="viz-tooltip-cat">${pt.category.replace(/_/g, ' ')}</span>`;
          // Dim others, highlight hovered
          spheres.forEach((s, i) => {
            const mat = s.material as THREE.MeshBasicMaterial;
            if (i === idx) {
              mat.opacity = 1;
              s.scale.setScalar(1.5);
            } else {
              mat.opacity = 0.3;
              s.scale.setScalar(1);
            }
          });
        }
        tooltip.style.left = e.clientX - container.getBoundingClientRect().left + 12 + 'px';
        tooltip.style.top = e.clientY - container.getBoundingClientRect().top - 10 + 'px';
      } else if (hoveredIndex !== -1) {
        hoveredIndex = -1;
        tooltip.style.display = 'none';
        spheres.forEach((s) => {
          const mat = s.material as THREE.MeshBasicMaterial;
          mat.opacity = 0.85;
          s.scale.setScalar(1);
        });
      }
    };

    const onClick = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);
      const intersects = raycaster.intersectObjects(spheres);
      if (intersects.length > 0) {
        const idx = spheres.indexOf(intersects[0].object as THREE.Mesh);
        const pt = pointData[idx];
        fetchMemory(pt.id).then((m: Memory) => {
          if (!disposed) setSelectedMemory(m);
        });
      }
    };

    container.addEventListener('mousemove', onMouseMove);
    container.addEventListener('click', onClick);

    const onResize = () => {
      if (disposed) return;
      camera.aspect = container.clientWidth / container.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    };
    window.addEventListener('resize', onResize);

    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(container);

    // Load data
    fetchEmbeddings().then((data) => {
      if (disposed) return;

      const points: EmbeddingPoint[] = data?.items || [];
      const geo = new THREE.SphereGeometry(0.04, 12, 12);

      points.forEach((pt) => {
        const color = new THREE.Color(CATEGORY_COLORS[pt.category] || 0x888888);
        const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(pt.x * SPREAD, pt.y * SPREAD, pt.z * SPREAD);
        scene.add(mesh);
        spheres.push(mesh);
        pointData.push(pt);
        originalColors.push(color);
      });

      // Lines between nearby same-category points
      const lineMat = new THREE.LineBasicMaterial({ color: 0x30363d, opacity: 0.3, transparent: true });
      for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
          if (points[i].category !== points[j].category) continue;
          const dx = (points[i].x - points[j].x) * SPREAD;
          const dy = (points[i].y - points[j].y) * SPREAD;
          const dz = (points[i].z - points[j].z) * SPREAD;
          const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (dist < CONNECT_DISTANCE * SPREAD) {
            const lineGeo = new THREE.BufferGeometry().setFromPoints([
              new THREE.Vector3(points[i].x * SPREAD, points[i].y * SPREAD, points[i].z * SPREAD),
              new THREE.Vector3(points[j].x * SPREAD, points[j].y * SPREAD, points[j].z * SPREAD),
            ]);
            scene.add(new THREE.Line(lineGeo, lineMat));
          }
        }
      }
    });

    // Animation loop
    let animId: number;
    const animate = () => {
      if (disposed) return;
      animId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    cleanupRef.current = () => {
      disposed = true;
      cancelAnimationFrame(animId);
      container.removeEventListener('mousemove', onMouseMove);
      container.removeEventListener('click', onClick);
      window.removeEventListener('resize', onResize);
      resizeObserver.disconnect();
      controls.dispose();
      renderer.dispose();
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => m.dispose());
          } else {
            obj.material.dispose();
          }
        } else if (obj instanceof THREE.Line) {
          obj.geometry.dispose();
          if (Array.isArray(obj.material)) {
            obj.material.forEach((m) => m.dispose());
          } else {
            obj.material.dispose();
          }
        }
      });
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };

    return () => {
      cleanupRef.current?.();
    };
  }, []);

  return (
    <div className="split-layout viz-layout">
      <div className="viz-container" ref={containerRef}>
        <div className="viz-tooltip" ref={tooltipRef} style={{ display: 'none' }} />
        <div className="viz-legend">
          <div className="viz-legend-item">
            <span className="viz-dot" style={{ background: '#3fb950' }} />
            learning
          </div>
          <div className="viz-legend-item">
            <span className="viz-dot" style={{ background: '#d29922' }} />
            review feedback
          </div>
          <div className="viz-legend-item">
            <span className="viz-dot" style={{ background: '#58a6ff' }} />
            codebase pattern
          </div>
        </div>
      </div>
      {selectedMemory && (
        <div className="split-detail">
          <DetailPanel
            type="memory"
            memory={selectedMemory}
            onClose={() => setSelectedMemory(null)}
            onDelete={handleDelete}
          />
        </div>
      )}
    </div>
  );
}
