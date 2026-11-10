import { AccountService } from "./service";
import { accountStore } from "./object";
import * as formatting from "./arrow";

export function handleAccountRequest(service: AccountService, id: string) {
  return service.loadAccount(id);
}

export function readAccount(id: string) {
  return accountStore.lookupAccount(id);
}

export function displayAccount(id: string) {
  return formatting.formatAccount(id);
}
