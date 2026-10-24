# Third-party notices

This is an independent learning prototype. It is not an official Draft, Google DeepMind, Microsoft or Pollen Robotics product.

- **Draft** generator, quadruped templates and Cheetah/Bear/Giraffe presets: David Nguyen and contributors, [davidhnguyen2000/draft](https://github.com/davidhnguyen2000/draft), pinned commit `3b03e144735098ef94b938e85756806f45628f83`, MIT. The complete original notice is retained in [play/DRAFT_LICENSE](play/DRAFT_LICENSE). The generated quadruped models derive from those specifications.
- **MuJoCo / MuJoCo WASM**: Google DeepMind, [google-deepmind/mujoco](https://github.com/google-deepmind/mujoco), Apache-2.0. Browser package version 3.11.0; Python generation version 3.8.0. Their respective packages retain their license notices.
- **ONNX Runtime Web**: Microsoft, [microsoft/onnxruntime](https://github.com/microsoft/onnxruntime), MIT, version 1.27.0.
- **Three.js**: [mrdoob/three.js](https://github.com/mrdoob/three.js), MIT, version 0.164.1.
- **React and ReactDOM**: Meta and contributors, [facebook/react](https://github.com/facebook/react), MIT, version 19.2.8.
- **Vite** and its React plugin: [vitejs/vite](https://github.com/vitejs/vite), MIT, versions 8.2.2 and 6.1.0.
- Python generation dependencies are installed from their packages, not vendored: NumPy, PyYAML, trimesh, mapbox-earcut, Rtree and SciPy. Their distributions carry their own notices.

The Flower YAML body plan, lab integration and bundled locomotion policies were authored/trained locally for this prototype. Cheetah training used the pinned Draft training configuration; Flower used its own 18-joint task. The included weights are small exported inference policies, not third-party VLM weights.

The optional vision adapter follows a locally authored prior adapter's transport/validation pattern. It has no dependency on or vendored code from the external HumanCLAW project.

No Microduck/Open Duck Mini hardware-derived CAD, meshes or policies are distributed here. The separate historical Microduck experiment is excluded from this repository.
