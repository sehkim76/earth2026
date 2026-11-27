import * as THREE from "three";

const SURFACES = {
  frame: [0x261e17, 0x92734c],
  sheet: [0xf1e3c7, 0xb4996f],
  row: [0xfff1d4, 0xbca47f],
  button: [0x382a20, 0x96744b],
  selected: [0xe4c483, 0xffdf9e],
  action: [0x3b5141, 0x82906c],
  warning: [0x542b24, 0xcf845f],
  disabled: [0x5d5547, 0x96836a],
  track: [0x987850, 0x7f6340],
  fill: [0xbe914b, 0xefbb6b],
} as const;

type SurfaceKind = keyof typeof SURFACES;

interface CityInterface {
  overlapsLabel: (x: number, y: number, width: number, height: number) => boolean;
  render: (renderer: THREE.WebGLRenderer) => void;
  dispose: () => void;
}

const vertexShader = /* glsl */ `
  varying vec2 panelUv;
  varying vec2 panelSize;
  void main() {
    panelUv = uv;
    panelSize = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 surface;
  uniform vec3 trim;
  varying vec2 panelUv;
  varying vec2 panelSize;
  void main() {
    vec2 p = (panelUv - 0.5) * panelSize;
    vec2 edge = panelSize * 0.5 - abs(p);
    float corner = min(edge.x, edge.y);
    if (edge.x + edge.y < min(4.0, panelSize.y * 0.4)) discard;
    float grain = fract(sin(dot(floor(gl_FragCoord.xy), vec2(12.9898, 78.233))) * 43758.5453);
    float fibers = sin(gl_FragCoord.y * 0.32 + sin(gl_FragCoord.x * 0.05) * 0.7);
    vec3 color = surface * (0.94 + 0.07 * panelUv.y + grain * 0.04 + fibers * 0.014);
    color = mix(color, trim, 1.0 - smoothstep(0.5, 1.7, corner));
    color += vec3(0.13, 0.09, 0.04) * (1.0 - smoothstep(1.0, 3.0, edge.y)) * panelUv.y;
    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

export function createCityInterface(host: HTMLElement, root: HTMLElement): CityInterface {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0.1, 10);
  camera.position.z = 2;
  const geometry = new THREE.PlaneGeometry();
  const materials = new Map<SurfaceKind, THREE.ShaderMaterial>();
  for (const kind of Object.keys(SURFACES) as SurfaceKind[]) {
    const [surface, trim] = SURFACES[kind];
    materials.set(kind, new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        surface: { value: new THREE.Color(surface) },
        trim: { value: new THREE.Color(trim) },
      },
    }));
  }

  const meshes = new Map<HTMLElement, THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>>();
  let dirty = true;
  let blockers: DOMRect[] = [];
  const invalidate = (): void => { dirty = true; };
  const resize = new ResizeObserver(invalidate);
  const mutations = new MutationObserver((entries) => {
    if (entries.some(({ target }) => {
      const element = target instanceof Element ? target : target.parentElement;
      return !element?.closest("[data-city-labels]");
    })) invalidate();
  });
  resize.observe(root);
  mutations.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-city-surface", "style", "hidden", "disabled"] });
  root.addEventListener("scroll", invalidate, true);

  const update = (): void => {
    const bounds = host.getBoundingClientRect();
    camera.right = Math.max(1, bounds.width);
    camera.top = Math.max(1, bounds.height);
    camera.updateProjectionMatrix();
    const elements = Array.from(root.querySelectorAll<HTMLElement>("[data-city-surface]"));
    const current = new Set(elements);
    blockers = [];
    for (const [element, mesh] of meshes) {
      if (!current.has(element)) {
        mesh.removeFromParent();
        meshes.delete(element);
      }
    }
    for (const [order, element] of elements.entries()) {
      const kind = element.dataset.citySurface as SurfaceKind;
      const material = materials.get(element.matches("button:disabled") ? "disabled" : kind);
      if (!material) continue;
      const rect = element.getBoundingClientRect();
      const clip = element.parentElement?.closest("[data-city-scroll]")?.getBoundingClientRect() ?? bounds;
      const left = Math.max(bounds.left, clip.left, rect.left);
      const right = Math.min(bounds.right, clip.right, rect.right);
      const top = Math.max(bounds.top, clip.top, rect.top);
      const bottom = Math.min(bounds.bottom, clip.bottom, rect.bottom);
      const width = right - left;
      const height = bottom - top;
      const existing = meshes.get(element);
      if (width <= 0 || height <= 0) {
        if (existing) existing.visible = false;
        continue;
      }
      if (kind === "frame" || kind === "sheet" || kind === "warning" || element.closest("nav")) {
        blockers.push(new DOMRect(left - bounds.left, top - bounds.top, width, height));
      }
      const mesh = existing ?? new THREE.Mesh(geometry, material);
      if (!existing) {
        mesh.frustumCulled = false;
        scene.add(mesh);
        meshes.set(element, mesh);
      }
      mesh.material = material;
      mesh.visible = true;
      mesh.position.set(left - bounds.left + width / 2, bounds.bottom - bottom + height / 2, 0);
      mesh.scale.set(width, height, 1);
      mesh.renderOrder = order;
    }
  };

  return {
    overlapsLabel(x, y, width, height) {
      return blockers.some((box) =>
        x + width / 2 > box.left && x - width / 2 < box.right && y > box.top && y - height < box.bottom,
      );
    },
    render(renderer) {
      if (dirty) {
        update();
        dirty = false;
      }
      renderer.autoClear = false;
      renderer.render(scene, camera);
      renderer.autoClear = true;
      if (root.dataset.cityWebgl !== "ready") root.dataset.cityWebgl = "ready";
    },
    dispose() {
      delete root.dataset.cityWebgl;
      resize.disconnect();
      mutations.disconnect();
      root.removeEventListener("scroll", invalidate, true);
      geometry.dispose();
      for (const material of materials.values()) material.dispose();
      meshes.clear();
      scene.clear();
    },
  };
}
