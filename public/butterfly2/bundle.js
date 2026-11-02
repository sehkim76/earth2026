(function () {
  var loader = new THREE.GLTFLoader();
  var raycaster = new THREE.Raycaster();
  var tapPosition = new THREE.Vector2();
  var loopRafId = 0;
  var lastFrameTime = 0;
  var elapsedTime = 0;

  var surface = null;
  var flyers = [];
  var mixers = [];

  var modelUrl = "./assets/butterfly.glb";

  function normalizeModelForAnimation(root) {
    root.traverse(function (node) {
      node.matrixAutoUpdate = true;

      if (node.isMesh) {
        node.castShadow = true;
      }
    });
  }

  function addFlightModel(gltf, x, z) {
    var scene = XR8.Threejs.xrScene().scene;
    var modelRoot = gltf.scene;

    normalizeModelForAnimation(modelRoot);

    modelRoot.position.set(x, 1.0 + Math.random() * 0.6, z);
    modelRoot.scale.set(0.65, 0.65, 0.65);
    modelRoot.rotation.y = Math.random() * Math.PI * 2;

    scene.add(modelRoot);

    if (gltf.animations && gltf.animations.length > 0) {
      var mixer = new THREE.AnimationMixer(modelRoot);
      for (var i = 0; i < gltf.animations.length; i += 1) {
        mixer.clipAction(gltf.animations[i]).play();
      }
      mixers.push(mixer);
    }

    flyers.push({
      root: modelRoot,
      originX: x,
      originY: modelRoot.position.y,
      originZ: z,
      hoverXAmplitude: 0.06 + Math.random() * 0.12,
      hoverZAmplitude: 0.04 + Math.random() * 0.1,
      hoverSpeed: 0.2 + Math.random() * 0.35,
      bobAmplitude: 0.22 + Math.random() * 0.35,
      bobSpeed: 1.4 + Math.random() * 1.8,
      phase: Math.random() * Math.PI * 2,
      tiltPhase: Math.random() * Math.PI * 2,
    });
  }

  function spawnFlyer(x, z) {
    loader.load(modelUrl, function (gltf) {
      addFlightModel(gltf, x, z);
    });
  }

  function animateFlyers(elapsed, deltaSeconds) {
    for (var i = 0; i < mixers.length; i += 1) {
      mixers[i].update(deltaSeconds);
    }

    for (var j = 0; j < flyers.length; j += 1) {
      var flyer = flyers[j];
      var angle = elapsed * flyer.hoverSpeed + flyer.phase;
      var nextX = flyer.originX + Math.sin(angle * 0.9) * flyer.hoverXAmplitude;
      var nextZ = flyer.originZ + Math.cos(angle * 0.7) * flyer.hoverZAmplitude;
      var nextY = flyer.originY
        + Math.sin(elapsed * flyer.bobSpeed + flyer.phase) * flyer.bobAmplitude
        + Math.sin(elapsed * (flyer.bobSpeed * 0.35) + flyer.tiltPhase) * 0.05;

      var dx = nextX - flyer.root.position.x;
      var dz = nextZ - flyer.root.position.z;

      flyer.root.position.set(nextX, nextY, nextZ);

      if (Math.abs(dx) + Math.abs(dz) > 0.0001) {
        var targetYaw = Math.atan2(dx, dz);
        flyer.root.rotation.y += (targetYaw - flyer.root.rotation.y) * 0.12;
      }

      flyer.root.rotation.z = Math.sin(elapsed * 6 + flyer.tiltPhase) * 0.2;
      flyer.root.rotation.x = Math.sin(elapsed * 4.2 + flyer.phase) * 0.1;
    }
  }

  function initXrScene(scene, camera, renderer) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    var directionalLight = new THREE.DirectionalLight(0xffffff, 1.1, 100);
    directionalLight.position.set(1, 4.3, 2.5);
    directionalLight.shadow.mapSize.width = 1024;
    directionalLight.shadow.mapSize.height = 1024;
    directionalLight.shadow.camera.near = 0.5;
    directionalLight.shadow.camera.far = 500;
    directionalLight.castShadow = true;

    scene.add(directionalLight);
    scene.add(new THREE.AmbientLight(0x404040, 5));

    surface = new THREE.Mesh(
      new THREE.PlaneGeometry(100, 100, 1, 1),
      new THREE.ShadowMaterial({ opacity: 0.45 })
    );
    surface.rotateX(-Math.PI / 2);
    surface.position.set(0, 0, 0);
    surface.receiveShadow = true;
    scene.add(surface);

    camera.position.set(0, 1.8, 2.8);
  }

  function placeFromTouch(event) {
    if (event.touches.length === 2) {
      XR8.XrController.recenter();
      return;
    }

    if (event.touches.length !== 1 || !surface) {
      return;
    }

    var touch = event.touches[0];
    tapPosition.x = (touch.clientX / window.innerWidth) * 2 - 1;
    tapPosition.y = -(touch.clientY / window.innerHeight) * 2 + 1;

    var xrScene = XR8.Threejs.xrScene();
    raycaster.setFromCamera(tapPosition, xrScene.camera);

    var intersects = raycaster.intersectObject(surface);
    if (intersects.length > 0 && intersects[0].object === surface) {
      spawnFlyer(intersects[0].point.x, intersects[0].point.z);
    }
  }

  function startFlightLoop() {
    var frame = function (timeMs) {
      if (lastFrameTime === 0) {
        lastFrameTime = timeMs;
      }

      var deltaSeconds = Math.min((timeMs - lastFrameTime) / 1000, 0.05);
      lastFrameTime = timeMs;
      elapsedTime += deltaSeconds;

      animateFlyers(elapsedTime, deltaSeconds);
      loopRafId = window.requestAnimationFrame(frame);
    };

    loopRafId = window.requestAnimationFrame(frame);
  }

  function stopFlightLoop() {
    if (loopRafId) {
      window.cancelAnimationFrame(loopRafId);
      loopRafId = 0;
    }
    lastFrameTime = 0;
  }

  function butterflyFlightPipelineModule() {
    return {
      name: "butterfly-flight",
      onStart: function (_args) {
        var canvas = _args.canvas;
        var xrScene = XR8.Threejs.xrScene();
        initXrScene(xrScene.scene, xrScene.camera, xrScene.renderer);

        canvas.addEventListener("touchstart", placeFromTouch, true);
        canvas.addEventListener("touchmove", function (event) {
          event.preventDefault();
        });

        startFlightLoop();

        XR8.XrController.updateCameraProjectionMatrix({
          origin: xrScene.camera.position,
          facing: xrScene.camera.quaternion,
        });
      },
      onDetach: function () {
        stopFlightLoop();
      },
    };
  }

  function onxrloaded() {
    XR8.addCameraPipelineModules([
      XR8.GlTextureRenderer.pipelineModule(),
      XR8.Threejs.pipelineModule(),
      XR8.XrController.pipelineModule(),
      window.LandingPage.pipelineModule(),
      XRExtras.FullWindowCanvas.pipelineModule(),
      XRExtras.Loading.pipelineModule(),
      XRExtras.RuntimeError.pipelineModule(),
      butterflyFlightPipelineModule(),
    ]);

    document.body.insertAdjacentHTML("beforeend", '<canvas id="camerafeed"></canvas>');
    XR8.run({ canvas: document.getElementById("camerafeed") });
  }

  XRExtras.Loading.showLoading({ onxrloaded: onxrloaded });
})();
