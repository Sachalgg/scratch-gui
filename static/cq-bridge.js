/**
 * cq-bridge.js — standalone "Save to Codaquest" button for scratch.codaquest.com.
 *
 * Drop into the scratch-gui fork at `static/cq-bridge.js` and load it from
 * `src/playground/index.ejs` just before </body>:
 *
 *   <script src="<%= htmlWebpackPlugin.options.publicPath %>cq-bridge.js"></script>
 *
 * Requires the fork to expose the scratch-vm instance on `window.ScratchVM`.
 * In an unmodified scratch-gui, edit `src/lib/vm-manager-hoc.jsx` (or wherever
 * the VM is constructed) to add:
 *
 *   const vm = new VirtualMachine();
 *   window.ScratchVM = vm;
 *
 * What this does:
 *   - Mounts a floating "Sauvegarder dans Mes projets" button in the page.
 *   - On click, asks scratch-vm for an .sb3 zip blob and POSTs it to the LMS
 *     at https://codabox.codaquest.com/api/projects/scratch-save with
 *     credentials: 'include'. The .codaquest.com Supabase session cookie is
 *     sent automatically because both subdomains share the registrable domain.
 *   - Remembers the LMS-returned project id in localStorage so subsequent
 *     saves update the same row instead of creating duplicates.
 */

(function () {
  'use strict';

  var LMS_ORIGIN = 'https://codabox.codaquest.com';
  var SAVE_URL = LMS_ORIGIN + '/api/projects/scratch-save';
  var STORAGE_KEY = 'cq_scratch_project_id';

  // ── Wait for scratch-vm to be available ─────────────────────────────────

  function waitForVM() {
    return new Promise(function (resolve) {
      var tries = 0;
      var iv = setInterval(function () {
        if (window.ScratchVM && typeof window.ScratchVM.saveProjectSb3 === 'function') {
          clearInterval(iv);
          resolve(window.ScratchVM);
        } else if (tries++ > 200) {
          clearInterval(iv);
          resolve(null);
        }
      }, 100);
    });
  }

  // ── Project title — read from the GUI's redux store, fall back gracefully ─

  function readTitle() {
    try {
      var store = window.__SCRATCHGUI_STORE__ || window.ReduxStore;
      if (store && typeof store.getState === 'function') {
        var s = store.getState();
        if (s && s.scratchGui && s.scratchGui.projectTitle) {
          return s.scratchGui.projectTitle;
        }
      }
    } catch (e) { /* fall through */ }
    var titleInput = document.querySelector('input[class*="title-field"]');
    if (titleInput && titleInput.value) return titleInput.value;
    return 'Projet Scratch';
  }

  // ── Save flow ───────────────────────────────────────────────────────────

  function setStatus(node, msg, kind) {
    node.textContent = msg;
    node.dataset.kind = kind || 'idle';
  }

  async function save(button, status) {
    var vm = window.ScratchVM;
    if (!vm) {
      setStatus(status, 'Editeur pas encore prêt', 'error');
      return;
    }
    button.disabled = true;
    setStatus(status, 'Sauvegarde…', 'progress');

    try {
      // saveProjectSb3 returns a Promise<Blob> in scratch-vm 0.2+.
      var blob = await vm.saveProjectSb3();
      if (!(blob instanceof Blob)) {
        throw new Error('vm.saveProjectSb3() did not return a Blob');
      }
      var form = new FormData();
      form.append('file', blob, 'project.sb3');
      form.append('title', readTitle());
      var existingId = localStorage.getItem(STORAGE_KEY);
      if (existingId) form.append('projectId', existingId);

      var res = await fetch(SAVE_URL, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (res.status === 401) {
        setStatus(status, 'Connecte-toi sur Codaquest pour sauvegarder', 'error');
        // Clear stale id — the user may have switched accounts.
        localStorage.removeItem(STORAGE_KEY);
        return;
      }
      if (!res.ok) {
        var msg = 'Erreur ' + res.status;
        try { var body = await res.json(); if (body && body.error) msg = body.error; } catch (e) { /* ignore */ }
        throw new Error(msg);
      }
      var json = await res.json();
      if (json && json.id) {
        localStorage.setItem(STORAGE_KEY, json.id);
      }
      setStatus(status, 'Sauvegardé dans Mes projets', 'ok');
    } catch (err) {
      setStatus(status, 'Echec : ' + (err && err.message ? err.message : err), 'error');
    } finally {
      button.disabled = false;
      setTimeout(function () {
        if (status.dataset.kind !== 'error') setStatus(status, '', 'idle');
      }, 4000);
    }
  }

  // ── UI: floating button + status pill ───────────────────────────────────

  function mountButton() {
    if (document.getElementById('cq-save-button')) return;

    var style = document.createElement('style');
    style.textContent =
      '#cq-save-wrap{position:fixed;top:12px;right:12px;z-index:99999;display:flex;align-items:center;gap:8px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}' +
      '#cq-save-button{background:#4D97FF;color:#fff;border:0;border-radius:8px;padding:8px 14px;font-weight:600;font-size:14px;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.15);}' +
      '#cq-save-button:hover:not(:disabled){background:#3a85ee;}' +
      '#cq-save-button:disabled{opacity:.6;cursor:wait;}' +
      '#cq-save-status{font-size:13px;padding:4px 10px;border-radius:6px;background:#fff;color:#333;box-shadow:0 1px 3px rgba(0,0,0,.1);max-width:260px;}' +
      '#cq-save-status:empty{display:none;}' +
      '#cq-save-status[data-kind="ok"]{background:#e8f6ee;color:#1a7f37;}' +
      '#cq-save-status[data-kind="error"]{background:#fdecea;color:#a3261a;}' +
      '#cq-save-status[data-kind="progress"]{background:#eef4ff;color:#1d4ed8;}';
    document.head.appendChild(style);

    var wrap = document.createElement('div');
    wrap.id = 'cq-save-wrap';
    var status = document.createElement('div');
    status.id = 'cq-save-status';
    var button = document.createElement('button');
    button.id = 'cq-save-button';
    button.type = 'button';
    button.textContent = 'Sauvegarder dans Mes projets';
    button.addEventListener('click', function () { save(button, status); });
    wrap.appendChild(status);
    wrap.appendChild(button);
    document.body.appendChild(wrap);
  }

  // ── Boot ────────────────────────────────────────────────────────────────

  function boot() {
    mountButton();
    waitForVM(); // warms up; the click handler re-reads window.ScratchVM
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
