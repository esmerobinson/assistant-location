// Shared hold menu for every recording mic in the apps: the one gesture all voice inputs follow.
//
//   tap            start recording; tap again stops it and does the surface's normal thing (send, or fill the box)
//   hold ~450ms    while recording, pops "Cancel ✕" and "Insert ↵" above the mic
//   release on Insert   stop and put the transcript in the surface's text box, unsent
//   release on Cancel   stop and throw the recording away
//   release elsewhere   dismiss the targets and keep recording
//
// A surface with no text box to insert into gets a Cancel-only menu (leave `insert` out of its actions).
//
// SOURCE of truth: design-tokens/voice-hold.js. design-tokens/build.mjs copies it byte-for-byte into each consumer
// (VOICE_HOLD_JS_OUTPUTS); the Overland-iOS repo keeps hand copies at CycleApp/web/voice-hold.js. Edit here, then copy.
// Older surfaces with their own implementation of the same gesture: Overland-iOS Modules/WebPages/session.html
// (attachMicHold), todo-sorter/public/app.js (attachMicHold), debate/public/voice.js.
//
// Loads as a classic <script> or as a side-effect ES-module import; either way it sets window.VoiceHold.
// The listeners are on `document` and the targets live in a body-level fixed element, never inside the mic's markup:
// apps re-render their mic buttons from HTML strings, and a press can outlive its button. Targets are hit-tested by
// rect against the pointer, so nothing depends on the original element still existing.
//
// VoiceHold.init({ mic, key, actions, holdMs })
//   mic       CSS selector matching a mic that is recording right now, e.g. '.mic.rec'
//   key(el)   which recording that mic controls, e.g. el.dataset.act; re-used to find the live mic after a re-render
//   actions(k) -> {cancel(), insert?()} for that recording, or null/undefined (no hold menu on it)
(function () {
  var HOLD_MS = 450;
  var MOVE_PX = 10; // a finger that moves before the hold fires is scrolling or dragging, not holding
  var SWALLOW_MS = 400; // a release that never produces a click must not eat the next real tap

  // Defaults only: prepended to <head>, so any app stylesheet overrides them. Colors come from --vhold-* when the app sets them.
  var CSS =
    '.vhold{position:fixed;z-index:1000;display:flex;gap:10px;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}' +
    '.vhold-t{min-width:96px;height:52px;padding:0 16px;box-sizing:border-box;border-radius:26px;display:flex;align-items:center;justify-content:center;' +
    'font-size:15px;font-weight:600;white-space:nowrap;pointer-events:none;background:var(--vhold-accent,#0a84ff);color:var(--vhold-on-accent,#fff);box-shadow:0 4px 14px rgba(0,0,0,.35)}' +
    '.vhold-t[data-t=cancel]{background:var(--vhold-surface,#1c1c1e);color:var(--vhold-text,#fff);border:1px solid var(--vhold-border,rgba(127,127,127,.3))}' +
    '.vhold-t.armed{transform:scale(1.12)}' +
    '.vhold-t[data-t=cancel].armed{background:var(--vhold-danger,#ff3b30);color:#fff;border-color:transparent}';

  function injectCss() {
    if (document.getElementById('vhold-css')) return;
    var s = document.createElement('style');
    s.id = 'vhold-css';
    s.textContent = CSS;
    document.head.insertBefore(s, document.head.firstChild);
  }

  function init(o) {
    if (!o || !o.mic || typeof o.key !== 'function' || typeof o.actions !== 'function') throw new Error('VoiceHold.init needs {mic, key, actions}');
    var holdMs = o.holdMs || HOLD_MS;
    var press = null;
    var swallow = false;
    var swallowTimer = null;
    injectCss();

    function liveMic(k) {
      var els = document.querySelectorAll(o.mic);
      for (var i = 0; i < els.length; i++) if (o.key(els[i]) === k) return els[i];
      return null;
    }
    function dismiss() {
      if (press) { clearTimeout(press.timer); if (press.menu) press.menu.remove(); }
      press = null;
    }
    function targetAt(x, y) {
      var kids = press.menu ? press.menu.children : [];
      for (var i = 0; i < kids.length; i++) {
        var r = kids[i].getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return kids[i];
      }
      return null;
    }
    function pop() {
      var btn = liveMic(press.key);
      var cfg = btn && o.actions(press.key);
      if (!cfg) return dismiss(); // recording ended (or the mic went away) before the hold fired
      var menu = document.createElement('div');
      menu.className = 'vhold';
      menu.setAttribute('role', 'menu');
      menu.innerHTML = '<span class="vhold-t" role="menuitem" data-t="cancel">Cancel ✕</span>' +
        (cfg.insert ? '<span class="vhold-t" role="menuitem" data-t="insert">Insert ↵</span>' : '');
      document.body.appendChild(menu);
      var r = btn.getBoundingClientRect();
      var w = menu.offsetWidth;
      var h = menu.offsetHeight;
      // Above the mic so the thumb does not cover them; below it only when there is no room above. Clamped to the viewport.
      var top = r.top - h - 12 >= 8 ? r.top - h - 12 : r.bottom + 12;
      menu.style.left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8)) + 'px';
      menu.style.top = Math.max(8, Math.min(top, window.innerHeight - h - 8)) + 'px';
      press.menu = menu;
      swallow = true;
      if (navigator.vibrate) navigator.vibrate(10);
    }
    document.addEventListener('pointerdown', function (e) {
      if (press || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      // A new press means the click that ended the last hold is long gone (or never came): never let it eat this tap.
      clearTimeout(swallowTimer);
      swallow = false;
      var el = e.target.closest && e.target.closest(o.mic);
      if (!el) return;
      var k = o.key(el);
      if (!o.actions(k)) return;
      press = { key: k, x0: e.clientX, y0: e.clientY, menu: null, timer: setTimeout(pop, holdMs) };
    }, true);
    document.addEventListener('pointermove', function (e) {
      if (!press) return;
      if (!press.menu) {
        if (Math.hypot(e.clientX - press.x0, e.clientY - press.y0) > MOVE_PX) dismiss();
        return;
      }
      var over = targetAt(e.clientX, e.clientY);
      for (var i = 0; i < press.menu.children.length; i++) press.menu.children[i].classList.toggle('armed', press.menu.children[i] === over);
    }, true);
    function end(e) {
      if (!press) return;
      var k = press.key;
      var menu = press.menu;
      var hit = menu && e.type === 'pointerup' ? targetAt(e.clientX, e.clientY) : null;
      var over = hit ? hit.dataset.t : null;
      dismiss();
      if (menu) swallowTimer = setTimeout(function () { swallow = false; }, SWALLOW_MS);
      // The recording must still be the live one: a re-render or a failed mic while the finger was down leaves nothing to act on.
      var cfg = over && liveMic(k) && o.actions(k);
      if (cfg && cfg[over]) cfg[over]();
    }
    document.addEventListener('pointerup', end, true);
    document.addEventListener('pointercancel', end, true);
    // Capture phase: runs before the app's own click delegation, which then never sees the click that ended a hold.
    document.addEventListener('click', function (e) { if (swallow) { swallow = false; e.stopPropagation(); e.preventDefault(); } }, true);
    // A long press raises the context menu on some browsers; with targets up it must not.
    document.addEventListener('contextmenu', function (e) { if (press && press.menu) e.preventDefault(); }, true);
  }

  window.VoiceHold = { init: init, HOLD_MS: HOLD_MS };
})();
