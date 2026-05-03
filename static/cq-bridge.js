/**
 * cq-bridge.js — Codaquest LMS ↔ scratch-gui postMessage bridge.
 *
 * Drop into your scratch-gui fork at `static/cq-bridge.js` and load it from
 * `src/playground/index.ejs` just before </body>:
 *
 *   <script src="<%= htmlWebpackPlugin.options.publicPath %>cq-bridge.js"></script>
 *
 * Requires the fork to expose the scratch-vm instance on `window.ScratchVM`.
 * In an unmodified scratch-gui you can do this by editing
 * `src/lib/vm-manager-hoc.jsx` (or your fork's equivalent VM setup) to add:
 *
 *   const vm = new VirtualMachine();
 *   window.ScratchVM = vm;       // <-- add this line
 *
 * The contract is the mirror of `lib/scratch-bridge.ts` in the LMS repo:
 *
 *   LMS → editor:  scratch:loadProject, scratch:requestExport,
 *                  scratch:saveDone, scratch:theme
 *   editor → LMS:  scratch:ready, scratch:exportData, scratch:saveRequest,
 *                  scratch:error
 *
 * Bundle envelope (transport JSON over postMessage):
 *
 *   {
 *     projectJson: <scratch-vm project.json>,
 *     assets: { "<md5ext>": { data: "<base64>", contentType: "image/svg+xml" } }
 *   }
 *
 * The bridge does nothing if the page isn't iframed (no parent or same window).
 */

(function () {
  'use strict';

  if (window === window.parent) {
    // Not iframed — running standalone, nothing to wire up
    return;
  }

  var ALLOWED_PARENT_ORIGINS = [
    // Edit to match your LMS deployments
    'https://codaquest.app',
    'https://www.codaquest.app',
    'http://localhost:3001',
  ];

  function parentOriginAllowed(origin) {
    return ALLOWED_PARENT_ORIGINS.indexOf(origin) !== -1 ||
      /^https:\/\/[a-z0-9-]+\.codaquest\.app$/i.test(origin);
  }

  function postToParent(msg) {
    // We don't know the parent origin until we receive a message; until then,
    // broadcast with '*' for `ready` only. After that, prefer the captured one.
    var target = capturedParentOrigin || '*';
    window.parent.postMessage(msg, target);
  }

  var capturedParentOrigin = null;
  var vmReadyPromise = waitForVM();

  function waitForVM() {
    return new Promise(function (resolve) {
      var tries = 0;
      var iv = setInterval(function () {
        if (window.ScratchVM && typeof window.ScratchVM.runtime === 'object') {
          clearInterval(iv);
          resolve(window.ScratchVM);
        } else if (tries++ > 200) {
          // ~20 s — give up but still resolve so callers don't hang forever
          clearInterval(iv);
          resolve(null);
        }
      }, 100);
    });
  }

  // ── Asset bundle helpers ──────────────────────────────────────────────────

  function uint8ToBase64(u8) {
    var CHUNK = 0x8000;
    var out = '';
    for (var i = 0; i < u8.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(out);
  }

  function base64ToUint8(b64) {
    var bin = atob(b64);
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  function collectAssets(vm) {
    // scratch-vm tracks every loaded asset on its storage runtime
    var storage = vm.runtime.storage;
    var bundle = {};
    if (!storage) return bundle;

    function takeFromTarget(target) {
      var allMedia = (target.sprite ? target.sprite.costumes : []).concat(
        target.sprite ? target.sprite.sounds : [],
      );
      for (var i = 0; i < allMedia.length; i++) {
        var m = allMedia[i];
        if (!m || !m.md5) continue;
        var md5ext = m.md5; // already includes extension (e.g. "abcd.svg")
        if (bundle[md5ext]) continue;
        var asset = m.asset;
        if (!asset || !asset.data) continue;
        bundle[md5ext] = {
          data: uint8ToBase64(asset.data),
          contentType: asset.assetType ? asset.assetType.contentType : 'application/octet-stream',
        };
      }
    }

    var targets = vm.runtime.targets || [];
    for (var t = 0; t < targets.length; t++) takeFromTarget(targets[t]);
    return bundle;
  }

  function loadAssets(vm, assets) {
    var storage = vm.runtime.storage;
    if (!storage || !assets) return;
    var keys = Object.keys(assets);
    for (var i = 0; i < keys.length; i++) {
      var md5ext = keys[i];
      var entry = assets[md5ext];
      if (!entry || !entry.data) continue;
      var dot = md5ext.lastIndexOf('.');
      var md5 = dot >= 0 ? md5ext.slice(0, dot) : md5ext;
      var ext = dot >= 0 ? md5ext.slice(dot + 1) : '';
      var assetType =
        ext === 'svg' ? storage.AssetType.ImageVector :
        ext === 'png' || ext === 'jpg' || ext === 'jpeg' ? storage.AssetType.ImageBitmap :
        ext === 'wav' || ext === 'mp3' ? storage.AssetType.Sound :
        storage.AssetType.ImageBitmap;
      var dataFmt =
        ext === 'svg' ? storage.DataFormat.SVG :
        ext === 'png' ? storage.DataFormat.PNG :
        ext === 'jpg' || ext === 'jpeg' ? storage.DataFormat.JPG :
        ext === 'wav' ? storage.DataFormat.WAV :
        ext === 'mp3' ? storage.DataFormat.MP3 :
        storage.DataFormat.PNG;
      try {
        storage.createAsset(assetType, dataFmt, base64ToUint8(entry.data), md5, true);
      } catch (e) {
        // Non-fatal — asset will fail to render but the rest loads
      }
    }
  }

  function exportBundle(vm) {
    var json;
    try {
      json = vm.toJSON();
    } catch (e) {
      throw new Error('vm.toJSON() failed: ' + (e && e.message));
    }
    var projectJson = typeof json === 'string' ? JSON.parse(json) : json;
    return {
      projectJson: projectJson,
      assets: collectAssets(vm),
    };
  }

  function loadBundle(vm, bundle) {
    if (!bundle || !bundle.projectJson) return Promise.reject(new Error('empty bundle'));
    loadAssets(vm, bundle.assets || {});
    var jsonString = JSON.stringify(bundle.projectJson);
    // scratch-vm accepts a JSON string or an .sb3 ArrayBuffer
    return vm.loadProject(jsonString);
  }

  // ── Theme application ────────────────────────────────────────────────────

  function applyTheme(theme) {
    var dark = theme === 'dark';
    document.body.classList.toggle('cq-theme-dark', dark);
    document.documentElement.classList.toggle('cq-theme-dark', dark);
    // If your fork has its own theming hooks, hook them in here.
    try {
      window.dispatchEvent(new CustomEvent('cq-theme-change', { detail: { theme: theme } }));
    } catch (e) { /* IE-era browsers — ignore */ }
  }

  // ── Inject a "Save to Codaquest" affordance inside the editor ────────────
  // The LMS already shows its own Save button overlaid on the iframe, so this
  // is optional. If you want a Save action inside the editor's menu bar,
  // implement it in your fork and have it call:
  //   window.parent.postMessage({ type: 'scratch:saveRequest' }, '*');

  // ── Message handler ──────────────────────────────────────────────────────

  window.addEventListener('message', function (event) {
    if (!event.data || typeof event.data !== 'object') return;
    if (!parentOriginAllowed(event.origin)) return;
    capturedParentOrigin = event.origin;

    var type = event.data.type;

    if (type === 'scratch:loadProject') {
      vmReadyPromise.then(function (vm) {
        if (!vm) return;
        loadBundle(vm, event.data.bundle).catch(function (err) {
          postToParent({ type: 'scratch:error', message: 'loadProject failed: ' + err.message });
        });
      });
    } else if (type === 'scratch:requestExport') {
      vmReadyPromise.then(function (vm) {
        if (!vm) {
          postToParent({ type: 'scratch:error', message: 'VM not ready' });
          return;
        }
        try {
          var bundle = exportBundle(vm);
          postToParent({
            type: 'scratch:exportData',
            bundle: bundle,
            requestId: event.data.requestId,
          });
        } catch (err) {
          postToParent({ type: 'scratch:error', message: err.message });
        }
      });
    } else if (type === 'scratch:saveDone') {
      // No-op for now — could surface a toast inside the editor if desired
    } else if (type === 'scratch:theme') {
      applyTheme(event.data.theme === 'dark' ? 'dark' : 'light');
    }
  });

  // ── Announce readiness once the VM is up ─────────────────────────────────

  vmReadyPromise.then(function (vm) {
    if (vm) {
      console.log('[cq-bridge] ready');
      postToParent({ type: 'scratch:ready' });
    } else {
      console.warn('[cq-bridge] VM never appeared on window.ScratchVM');
    }
  });
})();
