window.addEventListener('load', () => {
  const jazzminVersion = document.querySelector('.float-right.d-none.d-sm-inline');
  if (jazzminVersion) {
      jazzminVersion.remove();
  }
});