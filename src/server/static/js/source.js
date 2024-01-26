
// ON PAGE LOAD
document.addEventListener("DOMContentLoaded", () => {
  // DEBUGGING
  console.log('DOM IS LOADED'); // htmx.logAll();
});

// ON HTMX LOAD CONTENT / AJAX
htmx.on("htmx:load", function () {
  function confirmSwal(promptData, e) {;
    Swal.fire({
      title: "Proceed?",
      text: promptData,
      icon: "question"
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

  // BIND CONFIRMATION FUNCTION TO ALL DATA-CONFIRM TAGS
  const confirmators = document.querySelectorAll('[data-confirm]');
  Array.from(confirmators).forEach((element) => {
    const promptData = element.getAttribute('data-confirm');
    element.addEventListener('click', confirmSwal.bind(this, promptData));
    element.setAttribute('hx-trigger', 'confirmed');
    htmx.process(element); // HTMX ATTR REQUIRES PROCESSING
  });
});
