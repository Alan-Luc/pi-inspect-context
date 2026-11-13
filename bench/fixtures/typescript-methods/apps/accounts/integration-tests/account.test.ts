import { AccountService } from "../service";
test("loads account", () => { expect(new AccountService().loadAccount("a")).toBe("a"); });
