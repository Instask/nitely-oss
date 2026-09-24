import { createUser } from "../../src/web/users.js";

/**
 * Tokens must belong to a user, so any test that mints one needs a user to
 * own it. The password is returned so tests that also log in as the owner can.
 */
export async function createTokenOwner(
  repoPath: string,
  email = "owner@example.test",
): Promise<{ id: string; email: string; password: string }> {
  const password = "token owner password passphrase";
  const user = await createUser(repoPath, { email, password, role: "admin" });
  return { id: user.id, email: user.email, password };
}
