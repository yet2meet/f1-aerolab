# AeroLab CFD execution baseline

The browser application is the run-control and post-processing surface. Solver
geometry, meshing, CFD execution, convergence checks, and force integration live
outside Three.js.

## Geometry contract

Each adjustable aerodynamic component must be an independently named CAD body
with a stable hinge or datum. A rendering GLB may be derived from that CAD, but
it is not the solver source of truth.

Minimum component identities for the first full-car geometry:

- `front_wing_mainplane`
- `front_wing_flap_left` and `front_wing_flap_right`
- `rear_wing_mainplane`
- `rear_wing_flap`
- `floor_body`
- `diffuser_body`
- `wheel_front_left`, `wheel_front_right`, `wheel_rear_left`, and
  `wheel_rear_right`
- `chassis_body`

Every geometry export records its ruleset, revision, parameter values, units,
and a checksum. Parameters are separated into run conditions, driver controls,
garage setup, and design geometry so a wing change cannot alter chassis pose or
inlet direction.

## Reference solver chain

1. FreeCAD/OpenCascade produces a watertight parameterized STEP model and
   component surfaces.
2. `snappyHexMesh` creates the external-aerodynamics volume mesh with refinement
   around wings, wheels, floor, diffuser, and wake.
3. OpenFOAM runs steady incompressible RANS with `kOmegaSST` for the first
   engineering loop. The case uses a moving ground plane, rotating-wheel wall
   conditions, fixed world-axis inlet velocity, and pressure outlet.
4. The run is accepted only after mesh-quality gates, residual history, force
   stabilization, and a mesh-independence comparison are recorded.
5. ParaView/VTK output is converted to web-ready pressure surfaces, slices, and
   streamlines. The UI displays solver status and distinguishes converged CFD
   results from interactive estimates.

## First verified milestone

The first closed loop is intentionally narrow:

- one ruleset-specific car geometry;
- independently parameterized front-wing flap angle;
- fixed chassis pose and horizontal inlet direction;
- moving ground and four rotating wheels;
- three mesh levels for an independence check;
- drag, total downforce, front/rear balance, pressure coefficient, velocity
  slices, and affected-flow-region comparison against a baseline run.

The same job format can then add the rear wing, ride-height/platform state,
floor, diffuser, and ruleset-specific active-aero states without changing the
meaning of existing runs.

## Runtime boundary

GitHub Pages can host the browser application and static completed-result files.
It cannot execute OpenFOAM jobs. Interactive CFD runs require a local worker or
a separately hosted Linux compute service; each run must retain its geometry,
mesh, solver settings, residuals, and result manifest for reproducibility.
