# PushMimic Project Page

Source code for the project website of PushMimic.

Live site: https://arcad-lab-um.github.io/pushmimic/

## Interactive demo

The page runs the trained policy in the browser. MuJoCo 3.8.1 (`@mujoco/mujoco`) and
three.js 0.160.0 load from jsDelivr, and the policy network runs in plain JavaScript
(`static/js/demo/sim.js`). The model, weights and meshes in `static/demo/` are exported from the
training repository with MuJoCo 3.8.1, which must match the `@mujoco/mujoco` version the page loads.

## Acknowledgments

This website is built on the [Nerfies](https://nerfies.github.io) project page template.

## License

This work is licensed under a [Creative Commons Attribution-ShareAlike 4.0 International License](http://creativecommons.org/licenses/by-sa/4.0/).
