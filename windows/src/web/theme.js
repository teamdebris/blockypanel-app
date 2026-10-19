// Applies the saved theme before the page paints, so it doesn't flash light then dark.
try {
  var choice = localStorage.getItem("blocky-theme") || "system";
  var dark = choice === "dark" || (choice === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
} catch (e) {}
