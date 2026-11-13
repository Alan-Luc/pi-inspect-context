export class AccountService {
  loadAccount(id: string) { return this.repository.find(id); }
  repository = { find: (id: string) => id };
}
export const createAccountService = () => new AccountService();
