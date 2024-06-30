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

async function inviteSwal(inviteLink) {
  const invitePrompt = await Swal.fire({
    title: "Invite DiscoFlix",
    icon: "info",
    text: "Click the invite button or share the below URL",
    showCloseButton: true,
    confirmButtonText: "Invite",
    input: "url",
    inputPlaceholder: "No invite URL available",
    inputValue: inviteLink,
    inputAttributes: {
      readOnly: "true",
      style: "text-align: center;"
    },
    inputAutoFocus: "true",
  });
  
  if (invitePrompt.isConfirmed) {
    window.open(inviteLink, '_blank');
  }
}

function bindConfirmations(element) {
  const promptData = element.getAttribute('data-confirm');
  element.addEventListener('click', confirmSwal.bind(this, promptData));
  element.setAttribute('hx-trigger', 'confirmed');
  htmx.process(element); // HTMX ATTR REQUIRES PROCESSING
}

function bindInvites(element) {
  const inviteLink = element.getAttribute('data-invite');
  element.addEventListener('click', inviteSwal.bind(this, inviteLink));
}

htmx.on("htmx:load", function () {
  const confirmators = document.querySelectorAll('[data-confirm]');
  Array.from(confirmators).forEach(bindConfirmations);

  const inviteModals = document.querySelectorAll('[data-invite]');
  Array.from(inviteModals).forEach(bindInvites);

  const serverBubbleContainer = document.getElementById('serverBubbleContainer');
  const serverBubbleSortable = new Sortable(serverBubbleContainer, {
    animation: 150,
    ghostClass: 'ghost',
    delay: 50,
    delayOnTouchOnly: true,
    easing: "cubic-bezier(1, 0, 0, 1)",
    onEnd: function (evt) {
      this.option('disabled', true);
    }
  })
  serverBubbleContainer.addEventListener("htmx:afterSwap", function() {
    serverBubbleSortable.option('disabled', false);
  });
});
