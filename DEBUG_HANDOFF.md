# Runtime notes

No known blocking issue in the verified local installation and nominal manual walking path.

- Joystick input can start/resume directly; release requests balance, while Pause freezes physics. A zero command can still produce stepping and drift.
- Readiness checks compare the exact current Flower controller, policy, adapted XML, raw body and mesh to its passing report. Preserve these checks.
- Generation is CPU-only; each new morphology needs its own movement validation.
- Vision navigation previously reached two of three markers and stopped early. Smaller marker signs are present, but full-course VLM success is unverified.
- Browser automation can report bounds before scrolling settles; inspect the settled page before coordinate drags. This does not change robot physics.
- Physical touch/gamepad, Windows/macOS installs, remote hosting and manipulation remain untested.
