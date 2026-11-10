package service

func FetchLedgerEntry(ledger *Ledger, id string) string {
	return ledger.FetchEntry(id)
}
