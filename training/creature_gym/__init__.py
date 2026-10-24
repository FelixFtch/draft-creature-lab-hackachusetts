"""creature_gym: CPU-only skill training for Draft creature bodies.

Pipeline: ``creature-body/1`` directory -> simulation scene (sim_model) ->
vectorised MuJoCo rollouts (envs) -> PPO (ppo) -> ONNX bundle (export) ->
deterministic validation (evaluate). Everything runs on CPU threads; no CUDA,
mjlab or MuJoCo Warp. Modules import torch lazily so light tools (scene
building, evaluation) start fast.
"""

SCENE_SCHEMA = 'creature-scene/1'
POLICY_SCHEMA = 'creature-policy/1'
EVAL_SCHEMA = 'creature-eval/1'
FIXTURES_SCHEMA = 'creature-fixtures/1'
PROGRESS_SCHEMA = 'creature-train-progress/1'
BODY_SCHEMA = 'creature-body/1'
MUJOCO_VERSION = '3.11.0'
