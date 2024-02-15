
// ON PAGE LOAD
document.addEventListener("DOMContentLoaded", () => {
  // DEBUGGING
  console.log('DOM IS LOADED');
  //htmx.logAll();
});

// ON HTMX LOAD CONTENT / AJAX
htmx.on("htmx:load", function () {

  // BIND CONFIRMATION FUNCTION TO ALL DATA-CONFIRM TAGS
  function confirmSwal(promptData, e) {
    Swal.fire({
      title: "Proceed?",
      text: promptData,
      icon: "question",
      showCancelButton: true
    }).then(function (result) {
      if (result.isConfirmed) {
        Swal.fire({
          position: "top-end",
          icon: "success",
          showConfirmButton: false,
          timer: 1500
        }).then(() => htmx.trigger(e.target, 'confirmed'));
      }
    })
  }
  const confirmators = document.querySelectorAll('[data-confirm]');
  Array.from(confirmators).forEach((element) => {
    const promptData = element.getAttribute('data-confirm');
    element.addEventListener('click', confirmSwal.bind(this, promptData));
    element.setAttribute('hx-trigger', 'confirmed');
    htmx.process(element); // HTMX ATTR REQUIRES PROCESSING
  });

  // BIND INVITE MODAL TO ALL DATA-INVITE TAGS
  function inviteSwal(inviteLink) {
    Swal.fire({
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
      
    }).then(function (result) {
      if (result.isConfirmed) {
        window.open(inviteLink, '_blank');
      }
    });
  }
  const inviteModals = document.querySelectorAll('[data-invite]');
  Array.from(inviteModals).forEach((element) => {
    const inviteLink = element.getAttribute('data-invite');
    element.addEventListener('click', inviteSwal.bind(this, inviteLink));
  });

  // CONSTRUCT TOOLTIPS VIA TIPPY
  tippy('[data-tippy-content]', {
    interactiveDebounce: 75,
    offset: [0, 10],
    onTrigger(instance) {
      instance.hideWithInteractivity('mouseleave')
    }
  });

  // INITIALIZE SORTABLE LIB - SERVER ICON DRAGGING
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
