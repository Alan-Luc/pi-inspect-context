from service import BillingService


def handle_invoice(customer_id):
    return BillingService().charge_customer(customer_id)
