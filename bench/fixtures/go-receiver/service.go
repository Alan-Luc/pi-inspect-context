package service

type Ledger struct{}

func (l *Ledger) FetchEntry(id string) string { return id }
