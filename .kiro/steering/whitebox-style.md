---
inclusion: fileMatch
fileMatchPattern: ["play/src/**/*.js", "play/src/**/*.jsx", "play/src/**/*.css"]
---
# Visual direction: white-box world, robot as the hero

The team chose this direction explicitly. Keep it in every visual change.

- **White-box blockout, like a fresh Unreal Engine 5 level.** Matte white "plaster" surfaces, soft sun shadows, and thin topographic contour lines on terrain (`createTopoMaterial` in `play/src/app/whitebox.js`). The distant landscape is a white relief, like a hillshade or topo model. No textures, decals, banners or signage.
- **Simple and subdued.** Keep the scene calm. Remove clutter rather than add it, and keep layouts organised: collectibles sit evenly along each zone's axis so the robot can track them.
- **Only the robot and the things it interacts with carry colour.** Interactive props use the muted terracotta `HIGHLIGHT` (`#cf9273`). Obstacles may have a tint, but only at low saturation.
- **Low saturation everywhere.** Robot palettes are muted (default Sage Teal `#7fa39d`; see `PRODUCT_LOOKS` in `App.jsx`). UI accents are slate (`#5b6b84`). Avoid saturated primaries, including in icons.
- **Keep the classic Draft robot style.** Show the robot's real geometry: links, motors and spherical feet with derived shades (`createBasicView` in `draft-lab.js`). Gundam-like armour add-ons are allowed as optional looks, never as replacements.
- **No cartoon styling.** No toybox textures, mascots or bubbly fonts. The UI font is Inter, with keyline hairlines and small radii (`play/src/styles/premium.css`).
- **Camera.** The playground's default view is a close third-person chase camera behind the robot's back, looking at the robot (`play/src/world/camera.js`, mode `chase`). Driving ends the intro sweep immediately.

Before finishing a visual change, check it in the browser. The Playwright MCP server in `.kiro/settings/mcp.json` can open http://127.0.0.1:18381/ and take screenshots.
