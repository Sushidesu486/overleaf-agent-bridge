const verification = document.querySelector("[data-site-verify]");
if (verification) {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  if (token) {
    verification.elements.token.value = token;
    history.replaceState(null, "", location.pathname);
  }
  if (!verification.elements.token.value) {
    verification.hidden = true;
    const notice = document.createElement("p");
    notice.className = "alert alert-warning";
    notice.textContent = "Open the full verification link from your registration email, or request a new email.";
    verification.before(notice);
  }
}
for (const button of document.querySelectorAll("[data-site-submit]")) {
  button.form.addEventListener("submit", () => {
    button.disabled = true;
    button.textContent = "Processing…";
  });
}
window.addEventListener("pageshow", (event) => {
  if (event.persisted) location.reload();
});
