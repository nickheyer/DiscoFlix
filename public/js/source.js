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
