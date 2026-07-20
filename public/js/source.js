// Uncomment for htmx event logging
// htmx.logAll();

async function confirmSwal(promptData, e) {
  const initialPrompt = await Swal.fire({
    title: "Proceed?",
    text: promptData,
    icon: "question",
    showCancelButton: true
  });

  if (initialPrompt.isConfirmed) {
    await Swal.fire({
      position: "top-end",
      icon: "success",
      showConfirmButton: false,
      timer: 1500
    });
    htmx.trigger(e.target, 'confirmed')
  }
}

function bindConfirmations(element) {
  const promptData = element.getAttribute('data-confirm');
  element.addEventListener('click', confirmSwal.bind(this, promptData));
  element.setAttribute('hx-trigger', 'confirmed');
  htmx.process(element); // HTMX ATTR REQUIRES PROCESSING
}

// CLOSE THE MODAL FROM A CLICK HANDLER
function closeModal() {
  const modal = document.getElementById('modals-here');
  if (modal) bootstrap.Modal.getOrCreateInstance(modal).hide();
}

// THIS SCRIPT LOADS IN <HEAD>

// CLEAR CHAT INPUT ONCE ITS MESSAGE HAS GONE OVER THE SOCKET
document.addEventListener('htmx:wsAfterSend', function (evt) {
  const elt = (evt.detail && evt.detail.elt) || evt.target;
  const form = elt && elt.closest ? elt.closest('form.chatInputForm') : null;
  if (form) form.reset();
});

// AFTER A SETTINGS SEARCH RESPONSE SWAPS IN, SYNC THE SEARCH BOX TO QUERY
document.addEventListener('htmx:afterOnLoad', function (evt) {
  if (!evt.target || evt.target.id !== 'search-input') return;
  const canonical = document.querySelector("#state-management input[name='search']");
  if (canonical) evt.target.value = canonical.value;
});

htmx.on("htmx:load", function () {
  const confirmators = document.querySelectorAll('[data-confirm]');
  Array.from(confirmators).forEach(bindConfirmations);

  makeRailSortable('serverBubbleContainer');
  makeRailSortable('appBubbleContainer');
});

// ---- TOOLTIPS ----
// ONE FIXED-POSITION LAYER ON <body> INSTEAD OF HOST-ANCHORED PSEUDO-ELEMENTS,
// SO SCROLL CONTAINERS AND STACKING CONTEXTS CAN NEVER CLIP OR BURY A TOOLTIP.
// HOSTS DECLARE aria-label (THE TEXT) + data-tooltip-dir (top|bottom|left|right).
const TOOLTIP_GAP = 10;
const TOOLTIP_MARGIN = 6;
const TOOLTIP_SHOW_DELAY_MS = 120;
let tooltipLayer = null;
let tooltipAnchor = null;
let tooltipTimer = null;

function ensureTooltipLayer() {
  if (!tooltipLayer) {
    tooltipLayer = document.createElement('div');
    tooltipLayer.id = 'tooltipLayer';
    tooltipLayer.setAttribute('role', 'tooltip');
    document.body.appendChild(tooltipLayer);
  }
  return tooltipLayer;
}

function positionTooltip(anchor, dir) {
  const host = anchor.getBoundingClientRect();
  const tip = tooltipLayer.getBoundingClientRect();
  let top, left;
  switch (dir) {
    case 'bottom':
      top = host.bottom + TOOLTIP_GAP;
      left = host.left + host.width / 2 - tip.width / 2;
      break;
    case 'left':
      top = host.top + host.height / 2 - tip.height / 2;
      left = host.left - tip.width - TOOLTIP_GAP;
      break;
    case 'right':
      top = host.top + host.height / 2 - tip.height / 2;
      left = host.right + TOOLTIP_GAP;
      break;
    default:
      top = host.top - tip.height - TOOLTIP_GAP;
      left = host.left + host.width / 2 - tip.width / 2;
  }
  left = Math.max(TOOLTIP_MARGIN, Math.min(left, window.innerWidth - tip.width - TOOLTIP_MARGIN));
  top = Math.max(TOOLTIP_MARGIN, Math.min(top, window.innerHeight - tip.height - TOOLTIP_MARGIN));
  tooltipLayer.style.top = `${Math.round(top)}px`;
  tooltipLayer.style.left = `${Math.round(left)}px`;
}

function showTooltip(anchor) {
  const text = anchor.getAttribute('aria-label');
  if (!text) return;
  const dir = ['top', 'bottom', 'left', 'right'].includes(anchor.getAttribute('data-tooltip-dir'))
    ? anchor.getAttribute('data-tooltip-dir')
    : 'top';
  tooltipAnchor = anchor;
  ensureTooltipLayer();
  tooltipLayer.textContent = text;
  tooltipLayer.className = `dir-${dir}`; // MEASURE UNANIMATED, THEN REVEAL
  positionTooltip(anchor, dir);
  tooltipLayer.classList.add('visible');
}

function hideTooltip() {
  clearTimeout(tooltipTimer);
  tooltipTimer = null;
  tooltipAnchor = null;
  if (tooltipLayer) tooltipLayer.classList.remove('visible');
}

document.addEventListener('mouseover', function (evt) {
  const anchor = evt.target.closest ? evt.target.closest('[data-tooltip-dir]') : null;
  if (anchor === tooltipAnchor) return;
  hideTooltip();
  if (anchor) tooltipTimer = setTimeout(() => showTooltip(anchor), TOOLTIP_SHOW_DELAY_MS);
});

// KEYBOARD PARITY - FOCUS SHOWS THE SAME TOOLTIP HOVER WOULD
document.addEventListener('focusin', function (evt) {
  const anchor = evt.target.closest ? evt.target.closest('[data-tooltip-dir]') : null;
  if (anchor === tooltipAnchor) return;
  hideTooltip();
  if (anchor) showTooltip(anchor);
});

document.addEventListener('focusout', hideTooltip);
document.addEventListener('mousedown', hideTooltip);
document.addEventListener('scroll', hideTooltip, true);

// HTMX SWAPS CAN REMOVE A HOVERED HOST WITHOUT A mouseout EVER FIRING
document.addEventListener('htmx:afterSwap', function () {
  if (tooltipAnchor && !tooltipAnchor.isConnected) hideTooltip();
});

// ONE SORTABLE PER RAIL GROUP (GUILDS + APPS) - DRAGGING DISABLES ITSELF ON
// DROP UNTIL THE POST-SORT SWAP LANDS A FRESH CONTAINER
function makeRailSortable(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const sortable = new Sortable(container, {
    animation: 150,
    ghostClass: 'ghost',
    delay: 50,
    delayOnTouchOnly: true,
    easing: "cubic-bezier(1, 0, 0, 1)",
    onEnd: function (evt) {
      this.option('disabled', true);
    }
  });
  container.addEventListener("htmx:afterSwap", function () {
    sortable.option('disabled', false);
  });
}

// ---- TAB VIEWS ----
// A .dfTabs WRAPPER HOLDS ONE .dfTabBar OF [data-tab-target] BUTTONS AND THE
// .dfTabPanel SIBLINGS THEY POINT AT. DELEGATED: MODAL BODIES RE-RENDER ON
// EVERY SAVE, AND A FRESH RENDER FALLS BACK TO ITS SERVER-MARKED DEFAULT TAB.
document.addEventListener('click', function (evt) {
  const tab = evt.target.closest ? evt.target.closest('[data-tab-target]') : null;
  if (!tab) return;
  const tabs = tab.closest('.dfTabs');
  if (!tabs) return;
  tabs.querySelectorAll('[data-tab-target]').forEach(function (button) {
    const active = button === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  tabs.querySelectorAll('.dfTabPanel').forEach(function (panel) {
    panel.hidden = panel.id !== tab.getAttribute('data-tab-target');
  });
});

// ---- RELEASE TABLE SORTING ----
// HEAD BUTTONS REORDER THE FETCHED ROWS IN PLACE - THE ARRS ARE SLOW, SO THE
// SWEEP THAT ALREADY LANDED IS NEVER RE-ASKED. FIRST CLICK USES THE COLUMN'S
// NATURAL DIRECTION (BIGGEST/FRESHEST/BEST-SEEDED FIRST), A SECOND FLIPS IT;
// ROWS MISSING THE KEY SINK TO THE BOTTOM EITHER WAY.
const RELEASE_SORT_DEFAULT_DIR = { title: 'asc', quality: 'asc', size: 'desc', age: 'asc', seeders: 'desc' };
const RELEASE_SORT_NUMERIC = ['size', 'age', 'seeders'];

document.addEventListener('click', function (evt) {
  const button = evt.target.closest ? evt.target.closest('.releaseSort') : null;
  if (!button) return;
  const table = button.closest('.releaseTable');
  const rows = table ? table.querySelector('.releaseRows') : null;
  if (!rows) return;

  const key = button.getAttribute('data-sort');
  const dir = button.classList.contains('asc') ? 'desc'
    : button.classList.contains('desc') ? 'asc'
    : (RELEASE_SORT_DEFAULT_DIR[key] || 'asc');
  table.querySelectorAll('.releaseSort').forEach(function (other) {
    other.classList.remove('asc', 'desc');
  });
  button.classList.add(dir);

  const numeric = RELEASE_SORT_NUMERIC.includes(key);
  const factor = dir === 'asc' ? 1 : -1;
  Array.from(rows.children)
    .map(function (row, index) { return { row: row, index: index }; })
    .sort(function (a, b) {
      const va = a.row.getAttribute('data-' + key) || '';
      const vb = b.row.getAttribute('data-' + key) || '';
      if (!va || !vb) return (va ? 0 : 1) - (vb ? 0 : 1) || a.index - b.index;
      const cmp = numeric ? Number(va) - Number(vb) : va.localeCompare(vb);
      return cmp * factor || a.index - b.index;
    })
    .forEach(function (entry) { rows.appendChild(entry.row); });
});

// ---- CHAT HISTORY + DEEP LINKS ----

// A PREPENDED HISTORY BATCH CAN MAKE THE OLD SEAM DIVIDER A SAME-DAY DUPE -
// THE OOB ROW SWAP CANNOT REACH SIBLINGS, SO THE BATCH SHIPS THIS CALL
function dfTrimSeamDivider(rowId) {
  const row = document.getElementById(rowId);
  if (!row) return;
  const prev = row.previousElementSibling;
  if (prev && prev.classList.contains('dateDivider')) prev.remove();
}

// JUMP-TO-MESSAGE: CLOSE ANY MODAL, THEN SCROLL + FLASH THE ROW ONCE THE
// MIRROR SWAP HAS LANDED IT (RETRIES COVER THE SWAP RACE)
function dfFlashMessage(rowId, attempt) {
  attempt = attempt || 0;
  closeModal();
  const row = document.getElementById(rowId);
  if (!row) {
    if (attempt < 20) setTimeout(() => dfFlashMessage(rowId, attempt + 1), 100);
    return;
  }
  row.scrollIntoView({ block: 'center' });
  row.classList.add('flashHighlight');
  setTimeout(() => row.classList.remove('flashHighlight'), 2000);
}

// ---- TIME TRAVEL (ANCHORED WINDOWS) ----

// COLUMN-REVERSE MEASURES SCROLL FROM THE BOTTOM, SO A FUTURE PAGE APPENDED
// BELOW WOULD DRAG THE VIEWPORT DOWN WITH IT. PIN THE SEAM ROW (THE LAST ROW
// ABOVE THE SENTINEL) ACROSS THE SWAP SO THE OPERATOR NEVER FEELS THE PAGE.
let dfFutureSeam = null;
document.addEventListener('htmx:beforeSwap', function (evt) {
  const target = evt.detail && evt.detail.target;
  if (!target || !target.classList || !target.classList.contains('chatFutureSentinel')) return;
  const seam = target.previousElementSibling;
  if (seam) dfFutureSeam = { el: seam, top: seam.getBoundingClientRect().top };
});
document.addEventListener('htmx:afterSettle', function () {
  if (!dfFutureSeam) return;
  const scroller = document.querySelector('.messageContainer');
  if (scroller && dfFutureSeam.el.isConnected) {
    scroller.scrollTop += dfFutureSeam.el.getBoundingClientRect().top - dfFutureSeam.top;
  }
  dfFutureSeam = null;
});

// ---- CHAT UPLOAD (OG-DISCORD ATTACH) ----

// SERVER-INJECTED TUNED CAP (upload_max_mb, SET IN index.pug BEFORE THIS
// SCRIPT) - THE SERVER ENFORCES IT TOO; THIS PRE-FLIGHT JUST SAVES THE
// ROUND TRIP. THE LITERAL IS THE FALLBACK WHEN THE GLOBAL IS ABSENT.
const DF_UPLOAD_CAP = window.DF_UPLOAD_CAP || 8 * 1024 * 1024;

function dfStagedUploadFile() {
  const input = document.getElementById('chatUploadFile');
  return input && input.files && input.files[0] ? input.files[0] : null;
}

function dfClearUpload() {
  const input = document.getElementById('chatUploadFile');
  const preview = document.getElementById('chatUploadPreview');
  if (input) input.value = '';
  if (preview) preview.replaceChildren();
}

function dfHumanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// STAGED-FILE PREVIEW CHIP ABOVE THE CHAT BAR - IMAGE THUMB WHEN IT IS ONE,
// RED STATE WHEN OVER THE CAP (SEND BLOCKS CLIENT-SIDE). DELEGATED: THE CHAT
// BAR RE-RENDERS ON EVERY CHANNEL SWITCH.
document.addEventListener('change', function (evt) {
  if (!evt.target || evt.target.id !== 'chatUploadFile') return;
  const preview = document.getElementById('chatUploadPreview');
  if (!preview) return;
  preview.replaceChildren();
  const file = dfStagedUploadFile();
  if (!file) return;

  const chip = document.createElement('div');
  chip.className = `chatUploadChip${file.size > DF_UPLOAD_CAP ? ' oversize' : ''}`;
  if (file.type && file.type.startsWith('image/')) {
    const img = document.createElement('img');
    img.className = 'chatUploadThumb';
    img.src = URL.createObjectURL(file);
    img.onload = () => URL.revokeObjectURL(img.src);
    chip.appendChild(img);
  }
  const name = document.createElement('span');
  name.className = 'chatUploadName';
  name.textContent = file.name;
  const size = document.createElement('span');
  size.className = 'chatUploadSize';
  size.textContent = file.size > DF_UPLOAD_CAP
    ? `${dfHumanSize(file.size)} - over the 8MB cap`
    : dfHumanSize(file.size);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'chatUploadRemove';
  remove.setAttribute('aria-label', 'Remove attachment');
  remove.textContent = '×';
  remove.addEventListener('click', dfClearUpload);
  chip.append(name, size, remove);
  preview.appendChild(chip);
});

// ENTER ROUTING - A STAGED FILE SENDS THE MULTIPART FORM (WITH THE TYPED
// TEXT) INSTEAD OF THE ws-send TEXT FORM. CAPTURE PHASE BEATS THE BROWSER'S
// IMPLICIT SUBMIT OF THE TEXT FORM. ENTER ON THE + LABEL OPENS THE PICKER
// (LABELS DON'T FORWARD KEYS TO INPUTS ON THEIR OWN).
document.addEventListener('keydown', function (evt) {
  if (evt.key !== 'Enter' || evt.shiftKey) return;
  if (evt.target && evt.target.classList && evt.target.classList.contains('plusButton')) {
    evt.preventDefault();
    const fileInput = document.getElementById('chatUploadFile');
    if (fileInput) fileInput.click();
    return;
  }
  if (!evt.target || evt.target.id !== 'chatMessageInput') return;
  const file = dfStagedUploadFile();
  if (!file) return; // PLAIN TEXT - LET ws-send DO ITS THING
  evt.preventDefault();
  evt.stopPropagation();
  if (file.size > DF_UPLOAD_CAP) return; // THE CHIP ALREADY SAYS WHY
  const content = document.getElementById('chatUploadContent');
  if (content) content.value = evt.target.value || '';
  htmx.trigger('#chatUploadForm', 'submit');
}, true);

// SUCCESSFUL UPLOADS CLEAR THE STAGE + INPUT; FAILURES KEEP THE CHIP SO THE
// OPERATOR CAN RETRY (THE TOAST EXPLAINS WHAT WENT WRONG)
document.addEventListener('htmx:afterRequest', function (evt) {
  if (!evt.target || evt.target.id !== 'chatUploadForm') return;
  if (evt.detail && evt.detail.successful) {
    dfClearUpload();
    const input = document.getElementById('chatMessageInput');
    if (input) input.value = '';
  }
});
