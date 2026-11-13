import { accountStore } from "../object";

export function verifyAccount() {
  return accountStore.lookupAccount("fixture");
}
