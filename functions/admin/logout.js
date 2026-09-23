import { handleLogout } from "./_lib.js";

export async function onRequestPost() {
  return handleLogout();
}
