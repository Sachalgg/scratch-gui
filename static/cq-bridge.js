/**
 * cq-bridge.js — "Save to Codaquest" + "open a saved Codaquest project" for
 * scratch.codaquest.com.
 *
 * Drop into the scratch-gui fork at `static/cq-bridge.js` and load it from
 * `src/playground/index.ejs` just before </body>:
 *
 *   <script src="<%= htmlWebpackPlugin.options.publicPath %>cq-bridge.js"></script>
 *
 * Requires the fork to expose the scratch-vm instance on `window.ScratchVM`.
 * The fork does that in `src/reducers/vm.js`, beside the singleton the reducer
 * hands out:
 *
 *   const defaultVM = new VM();
 *   defaultVM.attachStorage(storage);
 *   if (typeof window !== 'undefined') window.ScratchVM = defaultVM;
 *
 * That runs at MODULE LOAD, so window.ScratchVM exists long before the GUI has
 * loaded any project into it. Hence waitForFirstProject() below.
 *
 * What this does:
 *   - SAVE. Mounts a floating "Sauvegarder dans Mes projets" button. On click,
 *     asks scratch-vm for an .sb3 zip blob and POSTs it to the LMS at
 *     https://codabox.codaquest.com/api/projects/scratch-save with
 *     credentials: 'include'. The .codaquest.com Supabase session cookie is
 *     sent automatically because both subdomains share the registrable domain.
 *     Remembers the LMS-returned project id FOR THIS PAGE LOAD so subsequent
 *     saves update the same row instead of creating duplicates.
 *   - OPEN. When the page is loaded as `/?cq_project=<id>` (which is what every
 *     "Ouvrir" link in Mes projets now points at), fetches that project's saved
 *     .sb3 back from the LMS and loads it into the VM before the child touches
 *     anything.
 *
 * Why OPEN has to exist: scratch-gui always boots on the stock empty project.
 * Saving worked end to end, but nothing could ever load a project back in, so a
 * child who saved their game and came back landed in a blank editor with none
 * of their work in it. The project was never lost. The editor was simply never
 * told which one to open.
 *
 * The same fact had a second, nastier consequence, which is why the write
 * target is no longer remembered across page loads. See `currentProjectId`.
 */

(function () {
  'use strict';

  var LMS_ORIGIN = 'https://codabox.codaquest.com';
  var SAVE_URL = LMS_ORIGIN + '/api/projects/scratch-save';
  // Retired. Read once on boot only to delete it, see clearLegacyProjectId().
  var LEGACY_STORAGE_KEY = 'cq_scratch_project_id';
  // Must match SCRATCH_EDITOR_PROJECT_PARAM in the LMS (lib/scratch-editor.ts).
  var PROJECT_PARAM = 'cq_project';

  /**
   * Which project THIS editor session writes to, and the single most important
   * variable in this file.
   *
   * It is per page load, deliberately, and it is only ever set from something
   * that happened in front of the child: a project we successfully loaded into
   * the VM, or a project the server just created for a save they made.
   *
   * It used to be a localStorage id that outlived the tab, and that is a way to
   * destroy a child's work. scratch-gui boots on the stock EMPTY project, so a
   * kid who opened the editor the next day and pressed Save out of habit
   * overwrote yesterday's game with a blank canvas: same project row, same R2
   * key, real .sb3 replaced by an empty one. Nothing in the LMS could tell that
   * apart from a legitimate save. There is a project in production right now
   * holding nothing but the 41 KB stock empty project.
   *
   * Null means "I do not know what this canvas belongs to", and the only safe
   * thing to do with an unknown canvas is let the server make a NEW project for
   * it. A duplicate row is an annoyance. An overwritten row is lost work.
   */
  var currentProjectId = null;

  /**
   * True only while WE are the ones calling vm.loadProject, so the watcher
   * below can tell our load apart from everyone else's.
   */
  var loadingOurProject = false;

  /**
   * Delete the retired key so an id left by the previous version of this file
   * cannot be picked up by anything later.
   */
  function clearLegacyProjectId() {
    try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch (e) { /* private mode */ }
  }

  /**
   * Let go of the project as soon as anything else loads a different one.
   *
   * scratch-gui can replace the VM's project without reloading the page:
   * "Fichier > Nouveau" and "Charger depuis ton ordinateur" both call
   * vm.loadProject. Holding on to the id across that is the localStorage bug
   * again in miniature. Open your game, pick New, press Save, and the blank
   * canvas lands on top of the game.
   *
   * Every load routes through runtime.handleProjectLoaded(), which emits
   * PROJECT_LOADED, so one listener covers all of them including ones added
   * later. Ours is the only load allowed to keep the id.
   */
  function forgetTargetOnForeignLoad(vm) {
    var runtime = vm && vm.runtime;
    if (!runtime || typeof runtime.on !== 'function') return;
    runtime.on('PROJECT_LOADED', function () {
      if (loadingOurProject) return;
      currentProjectId = null;
    });
  }

  function fileUrl(projectId) {
    return LMS_ORIGIN + '/api/projects/' + encodeURIComponent(projectId) + '/scratch-file';
  }

  // ── Wait for scratch-vm to be available ─────────────────────────────────

  function waitForVM() {
    return new Promise(function (resolve) {
      var tries = 0;
      var iv = setInterval(function () {
        var vm = window.ScratchVM;
        if (vm && typeof vm.saveProjectSb3 === 'function' && typeof vm.loadProject === 'function') {
          clearInterval(iv);
          resolve(vm);
        } else if (tries++ > 200) {
          clearInterval(iv);
          resolve(null);
        }
      }, 100);
    });
  }

  /**
   * Wait until scratch-gui has finished loading its OWN default project.
   *
   * window.ScratchVM exists the moment the VM is constructed, which is BEFORE
   * the GUI loads the stock empty project into it. Loading ours at that point
   * is a race we lose about as often as we win: the GUI's own load lands second
   * and replaces the child's game with the empty canvas, which looks exactly
   * like the bug this whole lane exists to fix. The runtime having targets is
   * the observable "the default project is in" signal.
   */
  function waitForFirstProject(vm) {
    return new Promise(function (resolve) {
      var tries = 0;
      var iv = setInterval(function () {
        var runtime = vm && vm.runtime;
        if (runtime && runtime.targets && runtime.targets.length > 0) {
          clearInterval(iv);
          resolve(true);
        } else if (tries++ > 200) {
          // 20s. Load anyway rather than leaving the child staring at a spinner.
          clearInterval(iv);
          resolve(false);
        }
      }, 100);
    });
  }

  // ── Project title — read from the GUI's redux store, fall back gracefully ─

  function guiStore() {
    var store = window.__SCRATCHGUI_STORE__ || window.ReduxStore;
    return store && typeof store.getState === 'function' ? store : null;
  }

  function titleInput() {
    return document.querySelector('input[class*="title-field"]');
  }

  function readTitle() {
    try {
      var store = guiStore();
      if (store) {
        var s = store.getState();
        if (s && s.scratchGui && s.scratchGui.projectTitle) {
          return s.scratchGui.projectTitle;
        }
      }
    } catch (e) { /* fall through */ }
    var input = titleInput();
    if (input && input.value) return input.value;
    return 'Projet Scratch';
  }

  /**
   * Best-effort: name the loaded project after its LMS title.
   *
   * Cosmetic only, and deliberately not fatal. The LMS title is authoritative
   * anyway (its save endpoint keeps a name the child set there rather than
   * letting an auto-save revert it), so a fork that exposes neither the store
   * nor a title input just shows the default and everything else still works.
   */
  function writeTitle(title) {
    if (!title) return;
    try {
      var store = guiStore();
      if (store && typeof store.dispatch === 'function') {
        store.dispatch({ type: 'scratch-gui/project-title/SET_PROJECT_TITLE', title: title });
      }
    } catch (e) { /* fall through to the DOM */ }
    var input = titleInput();
    if (!input) return;
    try {
      // React owns this input, so assigning .value directly is swallowed on the
      // next render. Go through the native setter and fire the event React
      // actually listens for.
      var setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value'
      );
      if (setter && setter.set) setter.set.call(input, title);
      else input.value = title;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) { /* cosmetic */ }
  }

  // ── Status pill ─────────────────────────────────────────────────────────

  function setStatus(node, msg, kind) {
    if (!node) return;
    node.textContent = msg;
    node.dataset.kind = kind || 'idle';
  }

  /** Clear a transient message after a beat, but never step on an error. */
  function clearStatusLater(node) {
    if (!node) return;
    setTimeout(function () {
      if (node.dataset.kind !== 'error') setStatus(node, '', 'idle');
    }, 4000);
  }

  // ── Which project did the LMS send us to? ───────────────────────────────

  function requestedProjectId() {
    try {
      var fromQuery = new URL(window.location.href).searchParams.get(PROJECT_PARAM);
      if (fromQuery) return fromQuery;
      // scratch-gui uses the hash for its own project ids, so accept a hash
      // form too for anything that cannot carry a query string.
      var hash = window.location.hash || '';
      var m = hash.match(new RegExp('[#&]' + PROJECT_PARAM + '=([^&]+)'));
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Drop the parameter once it has been consumed, from the query AND the hash.
   *
   * Without this, a refresh (or the browser restoring the tab) silently reloads
   * the LAST SAVED .sb3 over whatever the child has built since, which reads as
   * "Scratch deleted my work". Saves keep landing on the right row because the
   * id is held in currentProjectId for the rest of this page load.
   */
  function forgetProjectParam() {
    try {
      var url = new URL(window.location.href);
      var had = url.searchParams.has(PROJECT_PARAM);
      url.searchParams.delete(PROJECT_PARAM);
      var hash = url.hash.replace(
        new RegExp('([#&])' + PROJECT_PARAM + '=[^&]*(&|$)'),
        '$1'
      );
      if (!had && hash === url.hash) return;
      url.hash = hash === '#' ? '' : hash;
      window.history.replaceState(null, '', url.toString());
    } catch (e) { /* cosmetic */ }
  }

  // ── Open flow ───────────────────────────────────────────────────────────

  async function openProject(projectId, status, button) {
    // The canvas on screen is still the stock empty project until the load
    // lands. Saving it would not overwrite anything (currentProjectId is null
    // until then) but it would litter Mes projets with a blank duplicate, so
    // hold the button rather than explaining that afterwards.
    if (button) button.disabled = true;
    try {
      await openProjectInner(projectId, status);
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function openProjectInner(projectId, status) {
    setStatus(status, 'Ouverture du projet…', 'progress');

    var res;
    try {
      res = await fetch(fileUrl(projectId), {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
      });
    } catch (err) {
      setStatus(status, 'Impossible de joindre Codaquest', 'error');
      return;
    }

    if (res.status === 401) {
      setStatus(status, 'Connecte-toi sur Codaquest pour ouvrir ce projet', 'error');
      return;
    }
    if (!res.ok) {
      setStatus(status, 'Projet introuvable (' + res.status + ')', 'error');
      return;
    }

    var vm = await waitForVM();
    if (!vm) {
      setStatus(status, 'Editeur pas encore prêt', 'error');
      return;
    }

    try {
      var buffer = await res.arrayBuffer();
      if (!buffer || buffer.byteLength === 0) throw new Error('fichier vide');
      // Bail rather than load into a VM that never initialised. If the GUI's
      // own default-project load is still coming, it lands AFTER ours and
      // leaves an empty canvas pointed at a real project: the next save then
      // overwrites the child's game with it.
      if (!(await waitForFirstProject(vm))) {
        setStatus(status, 'Editeur pas prêt, recharge la page', 'error');
        return;
      }
      loadingOurProject = true;
      try {
        await vm.loadProject(buffer);
      } finally {
        loadingOurProject = false;
      }
      // Only adopt the id once the project is actually IN the editor. Adopting
      // it earlier would point the next save at a project the child never got
      // to see, and overwrite it with an empty canvas.
      currentProjectId = projectId;
      forgetProjectParam();
      var title = res.headers.get('X-Codaquest-Project-Title');
      writeTitle(title ? decodeURIComponent(title) : '');
      setStatus(status, 'Projet chargé', 'ok');
      clearStatusLater(status);
    } catch (err) {
      setStatus(status, 'Echec du chargement : ' + (err && err.message ? err.message : err), 'error');
    }
  }

  // ── Save flow ───────────────────────────────────────────────────────────

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
      // Empty on a fresh editor session, so the server creates a new project
      // rather than this blank canvas landing on top of an older one.
      if (currentProjectId) form.append('projectId', currentProjectId);

      var res = await fetch(SAVE_URL, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (res.status === 401) {
        setStatus(status, 'Connecte-toi sur Codaquest pour sauvegarder', 'error');
        // The user may have switched accounts, so this canvas no longer belongs
        // to whoever signs in next.
        currentProjectId = null;
        return;
      }
      if (!res.ok) {
        var msg = 'Erreur ' + res.status;
        try { var body = await res.json(); if (body && body.error) msg = body.error; } catch (e) { /* ignore */ }
        throw new Error(msg);
      }
      var json = await res.json();
      if (json && json.id) {
        currentProjectId = json.id;
      }
      // `forked: true` means the id we sent was not writable (deleted, someone
      // else's, not a Scratch project) and the work landed in a NEW project.
      // Say so, otherwise the child looks for their changes in the old one.
      setStatus(
        status,
        json && json.forked ? 'Sauvegardé dans un nouveau projet' : 'Sauvegardé dans Mes projets',
        'ok'
      );
    } catch (err) {
      setStatus(status, 'Echec : ' + (err && err.message ? err.message : err), 'error');
    } finally {
      button.disabled = false;
      clearStatusLater(status);
    }
  }

  // ── UI: floating button + status pill ───────────────────────────────────

  function mountButton() {
    if (document.getElementById('cq-save-button')) {
      return document.getElementById('cq-save-status');
    }

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
    return status;
  }

  // ── Boot ────────────────────────────────────────────────────────────────

  function boot() {
    clearLegacyProjectId();
    var status = mountButton();
    // Warms up the VM reference, and attaches the watcher that drops our write
    // target the moment scratch-gui loads something else into the editor.
    waitForVM().then(forgetTargetOnForeignLoad);
    var projectId = requestedProjectId();
    if (projectId) {
      openProject(projectId, status, document.getElementById('cq-save-button'));
    }
    // Otherwise this session starts unattached, so the first save creates a new
    // project and later saves in the same session update it.
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
