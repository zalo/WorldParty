# [WorldParty](https://zalo.github.io/WorldParty/)

<p align="left">
  <a href="https://github.com/zalo/WorldParty/deployments/activity_log?environment=github-pages">
      <img src="https://img.shields.io/github/deployments/zalo/WorldParty/github-pages?label=Github%20Pages%20Deployment" title="Github Pages Deployment"></a>
  <a href="https://github.com/zalo/WorldParty/commits/main">
      <img src="https://img.shields.io/github/last-commit/zalo/WorldParty" title="Last Commit Date"></a>
  <a href="https://github.com/zalo/WorldParty/blob/master/LICENSE">
      <img src="https://img.shields.io/github/license/zalo/WorldParty" title="License: MIT"></a>
</p>

A Multiplayer Sandbox for building Interactive Worlds

 # Building

This demo can either be run without building (in Chrome/Edge/Opera since raw three.js examples need [Import Maps](https://caniuse.com/import-maps)), or built with:
```
npm install
npm run build
```
After building, make sure to edit the index .html to point from `"./src/main.js"` to `"./build/main.js"`.

 # Dependencies
 - [three.js](https://github.com/mrdoob/three.js/) (3D Rendering Engine)
 - [esbuild](https://github.com/evanw/esbuild/) (Bundler)
