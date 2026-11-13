class BillingService:
    def charge_customer(self, customer_id):
        return customer_id

def create_invoice(service, customer_id):
    return service.charge_customer(customer_id)
