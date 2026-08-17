// open the repo link (header icon) in a new tab
document.addEventListener("DOMContentLoaded", function () {
  var repoLink = document.querySelector(".md-source");
  if (repoLink) {
    repoLink.setAttribute("target", "_blank");
    repoLink.setAttribute("rel", "noopener");
  }
});
