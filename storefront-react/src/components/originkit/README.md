# OriginKit Hero 58 install target

Run `scripts/install-originkit-hero58.ps1` from PowerShell. The CLI writes the official source under this directory according to `components.json`. `OriginKitHeroAdapter.js` discovers a local Hero 58 module and renders its component export when found; otherwise the VAPELAB particle-wave fallback remains active.

Because the generated export shape and component API are supplied by the authenticated OriginKit CLI, inspect the actual files with `npm run inspect:originkit` before considering this integration verified.
