from service import BillingService

def test_charge_customer():
    assert BillingService().charge_customer("customer-1") == "customer-1"
