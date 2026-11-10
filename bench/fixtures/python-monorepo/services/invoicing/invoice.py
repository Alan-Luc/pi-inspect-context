from service import BillingService

def issue_invoice():
    return BillingService().charge_customer("customer-1")
