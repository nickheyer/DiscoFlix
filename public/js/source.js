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
