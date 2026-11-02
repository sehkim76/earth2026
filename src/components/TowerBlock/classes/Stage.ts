import * as THREE from "three";
import gsap from "gsap";

export class Stage {
  private container: HTMLElement;
  private camera: THREE.OrthographicCamera;
  private scene: THREE.Scene;
  private renderer: THREE.WebGLRenderer;
  private light: THREE.DirectionalLight;
  private softLight: THREE.AmbientLight;
  private cameraTarget: THREE.Vector3;

  constructor(container: HTMLElement) {
    this.container = container;
    this.cameraTarget = new THREE.Vector3(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
    });

    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor("#D0CBC7", 1);
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();

    const aspect = window.innerWidth / window.innerHeight;
    const d = 20;
    this.camera = new THREE.OrthographicCamera(
      -d * aspect,
      d * aspect,
      d,
      -d,
      -100,
      1000
    );
    this.camera.position.set(2, 2, 2);
    this.camera.lookAt(this.cameraTarget);

    this.light = new THREE.DirectionalLight(0xffffff, 0.5);
    this.light.position.set(0, 499, 0);
    this.scene.add(this.light);

    this.softLight = new THREE.AmbientLight(0xffffff, 0.4);
    this.scene.add(this.softLight);

    window.addEventListener("resize", () => this.onResize());
    this.onResize();
  }

  setCamera(y: number, speed: number = 0.3): void {
    gsap.to(this.camera.position, {
      y: y + 4,
      ease: "power1.inOut",
      duration: speed,
    });
    gsap.to(this.cameraTarget, {
      y: y,
      ease: "power1.inOut",
      duration: speed,
      onUpdate: () => {
        this.camera.lookAt(this.cameraTarget);
      },
    });
  }

  private onResize(): void {
    const viewSize = 30;
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.camera.left = window.innerWidth / -viewSize;
    this.camera.right = window.innerWidth / viewSize;
    this.camera.top = window.innerHeight / viewSize;
    this.camera.bottom = window.innerHeight / -viewSize;
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  add(elem: THREE.Object3D): void {
    this.scene.add(elem);
  }

  remove(elem: THREE.Object3D): void {
    this.scene.remove(elem);
  }

  dispose(): void {
    window.removeEventListener("resize", () => this.onResize());
    this.renderer.dispose();
    this.scene.clear();
  }
}
